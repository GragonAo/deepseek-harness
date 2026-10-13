import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { zipSync } from 'fflate'
import { SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as SkillTier from '@deepseek-ai/dsh-skill-tier'
import * as SkillInstall from '@deepseek-ai/dsh-skill-install'
import { DEFAULT_TENANT_ADMIN_SCOPE, TenantRegistry } from '@deepseek-ai/dsh-tenant'
import { TenantAdmin } from '@deepseek-ai/dsh-tenant-admin'
import JwtTenantAuthenticator from '@deepseek-ai/dsh-tenant-auth-jwt'
import TenantAdminHttp, { ADMIN_PATH, ADMIN_OPENAPI_PATH } from '../src/index.ts'

const ISSUER = 'tenant-admin-http-test'
const SECRET = 'admin-http-test-secret-long-enough-for-hs256'
const key = new TextEncoder().encode(SECRET)
const ADMIN_SCOPE = DEFAULT_TENANT_ADMIN_SCOPE

const SKILL_DOCUMENT = [
  '---',
  'name: uploaded-skill',
  'description: An uploaded skill.',
  '---',
  '',
  'Do the uploaded thing.',
  '',
].join('\n')

/** Build a skill bundle from a path-to-text map. */
function skillBundle(files: Record<string, string>): string {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, text] of Object.entries(files)) entries[path] = new TextEncoder().encode(text)
  return Buffer.from(zipSync(entries)).toString('base64')
}

interface Assembly {
  readonly base: string
  /** Host root the assembly provisioned tenant and user directories under. */
  readonly root: string
  /** System skill tier directory the assembly serves. */
  readonly skills: string
  dispose(): Promise<void>
}

/** Boot the management surface over a real web server, registry, and JWT authenticator. */
async function boot(config: { maxRequestBodyBytes?: number; openapi?: boolean; skillStack?: boolean } = {}): Promise<Assembly> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-admin-http-'))
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(TenantRegistry)
  await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: SECRET })
  await ctx.plugin(TenantAdmin, { usersRoot: join(root, 'users') })
  if (config.skillStack !== false) {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFilesystem, { includeDefaultRoots: false })
    await ctx.plugin(SkillTier, { systemSkillsDir: join(root, 'system', 'skills') })
    await ctx.plugin(SkillInstall)
  }
  await ctx.plugin(TenantAdminHttp, {
    ...(config.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: config.maxRequestBodyBytes } : {}),
    ...(config.openapi !== undefined ? { openapi: config.openapi } : {}),
  })
  return {
    base: `http://127.0.0.1:${String(ctx.webServer.port)}`,
    root,
    skills: join(root, 'system', 'skills'),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** Mint one bearer token; a payload without `tenantId` is a platform credential. */
function mintToken(claims: { tenant?: string; subject?: string; scope?: string }): Promise<string> {
  const payload: JWTPayload = { sub: claims.subject ?? 'operator' }
  if (claims.tenant !== undefined) payload.tenantId = claims.tenant
  if (claims.scope !== undefined) payload.scope = claims.scope
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key)
}

interface CallResult {
  readonly status: number
  readonly body: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
}

/** POST one management method. */
async function call(assembly: Assembly, method: string, payload: unknown, token?: string): Promise<CallResult> {
  const response = await fetch(`${assembly.base}${ADMIN_PATH}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() as CallResult['body'] }
}

const cleanups: Array<() => Promise<void>> = []

async function assembly(config: { maxRequestBodyBytes?: number; skillStack?: boolean } = {}): Promise<Assembly> {
  const booted = await boot(config)
  cleanups.push(async () => {
    await booted.dispose()
    await rm(booted.root, { recursive: true, force: true })
  })
  return booted
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const createPayload = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  dataRoot: `/data/${id}`,
  workspaceRoot: `/workspace/${id}`,
  ...extra,
})

describe('TenantAdminHttp', () => {
  it('refuses a request without a credential', async () => {
    const stack = await assembly()
    const result = await call(stack, 'tenants.list', {})
    expect(result.status).toBe(401)
    expect(result.body.error?.code).toBe('MISSING_CREDENTIAL')
  })

  it('refuses a token without the administrative scope', async () => {
    const stack = await assembly()
    const token = await mintToken({ tenant: 'acme', scope: 'sessions:write' })
    const result = await call(stack, 'tenants.list', {}, token)
    expect(result.status).toBe(403)
    expect(result.body.error).toMatchObject({ code: 'tenant-forbidden', details: { scope: ADMIN_SCOPE } })
  })

  it('admits a platform token that names no tenant', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const created = await call(stack, 'tenants.create', createPayload('acme'), token)
    expect(created.status).toBe(200)
    expect(created.body.value).toMatchObject({ id: 'acme', enabled: true, members: [] })

    const listed = await call(stack, 'tenants.list', {}, token)
    expect(listed.status).toBe(200)
    expect(listed.body.value).toMatchObject({ items: [{ id: 'acme' }] })
  })

  it('provisions the tenant host directories', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const root = await mkdtemp(join(stack.root, 'tenant-'))
    const payload = {
      id: 'acme',
      name: 'Acme',
      dataRoot: join(root, 'data'),
      workspaceRoot: join(root, 'workspace'),
    }
    await call(stack, 'tenants.create', payload, token)
    await expect(stat(join(root, 'data'))).resolves.toBeDefined()
    await expect(stat(join(root, 'workspace', 'shared', 'skills'))).resolves.toBeDefined()
  })

  it('updates metadata, flips enablement, and reads a record back', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    await call(stack, 'tenants.create', createPayload('acme'), token)

    const updated = await call(stack, 'tenants.update', { id: 'acme', name: 'Acme Ltd' }, token)
    expect(updated.body.value).toMatchObject({ id: 'acme', name: 'Acme Ltd' })

    const disabled = await call(stack, 'tenants.disable', { id: 'acme' }, token)
    expect(disabled.body.value).toMatchObject({ enabled: false })
    const enabled = await call(stack, 'tenants.enable', { id: 'acme' }, token)
    expect(enabled.body.value).toMatchObject({ enabled: true })

    const read = await call(stack, 'tenants.get', { id: 'acme' }, token)
    expect(read.body.value).toMatchObject({ id: 'acme', name: 'Acme Ltd' })
  })

  it('admits and drops members, creating the directories their sandbox mounts', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const root = await mkdtemp(join(stack.root, 'tenant-'))
    await call(stack, 'tenants.create', {
      id: 'acme',
      name: 'acme',
      dataRoot: join(root, 'data'),
      workspaceRoot: join(root, 'workspace'),
    }, token)

    const added = await call(stack, 'members.add', { id: 'acme', subject: 'user-1' }, token)
    expect(added.body.value).toEqual({ members: ['user-1'] })
    await expect(stat(join(root, 'workspace', 'users', 'user-1'))).resolves.toBeDefined()
    await expect(stat(join(stack.root, 'users', 'user-1', 'skills'))).resolves.toBeDefined()

    const listed = await call(stack, 'members.list', { id: 'acme' }, token)
    expect(listed.body.value).toEqual({ members: ['user-1'] })

    const removed = await call(stack, 'members.remove', { id: 'acme', subject: 'user-1' }, token)
    expect(removed.body.value).toEqual({ members: [] })
  })

  it('provisions a subject no tenant has admitted', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const ensured = await call(stack, 'users.ensure', { subject: 'user-9' }, token)
    expect(ensured.status).toBe(200)
    expect(ensured.body.value).toEqual({ root: join(stack.root, 'users', 'user-9') })
    await expect(stat(join(stack.root, 'users', 'user-9', 'tools'))).resolves.toBeDefined()
  })

  it('removes a tenant record and then reports it unknown', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    await call(stack, 'tenants.create', createPayload('acme'), token)
    const removed = await call(stack, 'tenants.remove', { id: 'acme' }, token)
    expect(removed.body.value).toEqual({ removed: true })
    const read = await call(stack, 'tenants.get', { id: 'acme' }, token)
    expect(read.status).toBe(404)
    expect(read.body.error?.code).toBe('tenant-not-found')
  })

  it('conflicts when the tenant id already exists', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    await call(stack, 'tenants.create', createPayload('acme'), token)
    const duplicate = await call(stack, 'tenants.create', createPayload('acme'), token)
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error?.code).toBe('tenant-conflict')
  })

  it('rejects an invalid payload with the schema issues', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const result = await call(stack, 'tenants.create', { id: 'acme' }, token)
    expect(result.status).toBe(400)
    expect(result.body.error?.code).toBe('bad-request')
    expect(result.body.error?.details?.issues).toBeDefined()
  })

  it('rejects a body that is not JSON', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const response = await fetch(`${stack.base}${ADMIN_PATH}/tenants.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'not json',
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('answers POST only', async () => {
    const stack = await assembly()
    const response = await fetch(`${stack.base}${ADMIN_PATH}/tenants.list`, { method: 'GET' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('reports an unknown method', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const result = await call(stack, 'tenants.frobnicate', {}, token)
    expect(result.status).toBe(404)
    expect(result.body.error?.code).toBe('unknown-method')
  })

  it('bounds the request body', async () => {
    const stack = await assembly({ maxRequestBodyBytes: 64 })
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const result = await call(stack, 'tenants.create', createPayload('acme'), token)
    expect(result.status).toBe(413)
    expect(result.body.error?.code).toBe('request-too-large')
  })

  it('publishes its own wire reference', async () => {
    const stack = await assembly()
    const response = await fetch(`${stack.base}${ADMIN_OPENAPI_PATH}`)
    expect(response.status).toBe(200)
    const document = await response.json() as { paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } }
    expect(Object.keys(document.paths)).toHaveLength(14)
    expect(document.paths[`${ADMIN_PATH}/tenants.create`]).toBeDefined()
    expect(document.paths[`${ADMIN_PATH}/users.ensure`]).toBeDefined()
    expect(document.paths[`${ADMIN_PATH}/skills.upload`]).toBeDefined()
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
  })

  it('serves no wire reference when disabled', async () => {
    const stack = await boot({ openapi: false })
    try {
      await expect(fetch(`${stack.base}${ADMIN_OPENAPI_PATH}`)).resolves.toMatchObject({ status: 404 })
    } finally {
      await stack.dispose()
      await rm(stack.root, { recursive: true, force: true })
    }
  })
})

describe('TenantAdminHttp skills methods', () => {
  it('installs a bundle, refreshes the catalog, and lists the refreshed tier', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })

    const uploaded = await call(stack, 'skills.upload', {
      tier: 'system',
      zip: skillBundle({ 'SKILL.md': SKILL_DOCUMENT }),
    }, token)

    expect(uploaded.status).toBe(200)
    expect(uploaded.body.value).toMatchObject({
      tier: 'system',
      name: 'uploaded-skill',
      directory: join(stack.skills, 'uploaded-skill'),
      replaced: false,
      files: ['SKILL.md'],
      visible: true,
    })

    const listed = await call(stack, 'skills.list', { tier: 'system' }, token)
    expect(listed.status).toBe(200)
    expect(listed.body.value).toMatchObject({
      directory: stack.skills,
      entries: [{ entry: 'uploaded-skill', name: 'uploaded-skill', description: 'An uploaded skill.', loadable: true, issues: [] }],
    })
  })

  it('refuses a bundle whose skill document cannot load, naming each issue', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const broken = ['---', 'name: case-knowledge-base', 'description: A skill.', 'mainSteps: # note', '', 'Body.'].join('\n')

    const result = await call(stack, 'skills.upload', { tier: 'system', zip: skillBundle({ 'SKILL.md': broken }) }, token)

    expect(result.status).toBe(400)
    expect(result.body.error?.code).toBe('skill-invalid')
    expect(result.body.error?.details?.issues).toMatchObject([{ code: 'frontmatter-unterminated', line: 1 }])
  })

  it('refuses a payload that is not base64 and bytes that are not an archive', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })

    const notBase64 = await call(stack, 'skills.upload', { tier: 'system', zip: 'not base64!!' }, token)
    expect(notBase64.status).toBe(400)
    expect(notBase64.body.error?.code).toBe('bad-request')

    const notZip = await call(stack, 'skills.upload', {
      tier: 'system',
      zip: Buffer.from('plain text, not an archive').toString('base64'),
    }, token)
    expect(notZip.status).toBe(400)
    expect(notZip.body.error?.code).toBe('bundle-invalid')
  })

  it('conflicts on a repeated name and replaces it when asked', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const zip = skillBundle({ 'SKILL.md': SKILL_DOCUMENT })
    await call(stack, 'skills.upload', { tier: 'system', zip }, token)

    const conflict = await call(stack, 'skills.upload', { tier: 'system', zip }, token)
    expect(conflict.status).toBe(409)
    expect(conflict.body.error?.code).toBe('skill-exists')

    const replaced = await call(stack, 'skills.upload', {
      tier: 'system',
      replace: true,
      zip: skillBundle({ 'SKILL.md': SKILL_DOCUMENT.replace('An uploaded skill.', 'A replaced skill.') }),
    }, token)
    expect(replaced.status).toBe(200)
    expect(replaced.body.value).toMatchObject({ replaced: true, visible: true })
    const listed = await call(stack, 'skills.list', { tier: 'system' }, token)
    expect(listed.body.value).toMatchObject({
      entries: [{ entry: 'uploaded-skill', description: 'A replaced skill.', loadable: true, issues: [] }],
    })
  })

  it('reports a hand-placed skill that never reaches the catalog', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    await mkdir(join(stack.skills, '知识库'), { recursive: true })
    await writeFile(join(stack.skills, '知识库', 'SKILL.md'), ['---', 'name: case-knowledge-base', '', 'Body.'].join('\n'))

    const listed = await call(stack, 'skills.list', { tier: 'system' }, token)

    expect(listed.body.value).toMatchObject({
      entries: [{
        entry: '知识库',
        loadable: false,
        issues: [{ code: 'frontmatter-unterminated', line: 1 }],
      }],
    })
  })

  it('removes an installed skill and reports an absent one', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    await call(stack, 'skills.upload', { tier: 'system', zip: skillBundle({ 'SKILL.md': SKILL_DOCUMENT }) }, token)

    const removed = await call(stack, 'skills.remove', { tier: 'system', name: 'uploaded-skill' }, token)
    expect(removed.status).toBe(200)
    expect(removed.body.value).toMatchObject({ name: 'uploaded-skill', visible: false })

    const absent = await call(stack, 'skills.remove', { tier: 'system', name: 'uploaded-skill' }, token)
    expect(absent.status).toBe(404)
    expect(absent.body.error?.code).toBe('skill-absent')
  })

  it('answers skill-install-unavailable when the composition mounts no installer', async () => {
    const stack = await assembly({ skillStack: false })
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const result = await call(stack, 'skills.list', { tier: 'system' }, token)
    expect(result.status).toBe(503)
    expect(result.body.error?.code).toBe('skill-install-unavailable')
  })

  it('refuses a tier the request scope does not publish', async () => {
    const stack = await assembly()
    const token = await mintToken({ scope: ADMIN_SCOPE })
    const result = await call(stack, 'skills.list', { tier: 'case' }, token)
    expect(result.status).toBe(503)
    expect(result.body.error?.code).toBe('tier-unavailable')
  })
})
