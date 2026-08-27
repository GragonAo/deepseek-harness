import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { TenantId, runWithTenant } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { assembleDemo } from '../src/assembly.ts'
import type { DemoAssembly } from '../src/assembly.ts'

const postgresUrl = process.env.TEST_POSTGRES_URL
const runtime = process.env.TEST_CONTAINER_RUNTIME ?? 'docker'

function tenant(id: string, workspaceRoot: string): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot,
  }
}

const runtimeAvailable = postgresUrl !== undefined && spawnSync(runtime, ['info']).status === 0
const suite = runtimeAvailable ? describe : describe.skip
if (!runtimeAvailable) {
  console.warn('[tenant-demo e2e] skipped: set TEST_POSTGRES_URL and ensure a container runtime is available')
}

suite('tenant demo end-to-end isolation', () => {
  let assembly: DemoAssembly
  let acmeDir: string
  let globexDir: string
  const issuer = 'https://demo.issuer.local'
  const secret = 'demo-shared-secret-for-tests-only-not-for-production'

  const sign = (tenantId: string): Promise<string> =>
    new SignJWT({ tenantId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setSubject('demo-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret))

  interface RunBody {
    ok?: boolean
    result?: { marker: string }
    error?: { code: string }
  }

  const run = async (tenantId: string): Promise<{ status: number; body: RunBody }> => {
    const response = await fetch(`http://127.0.0.1:${assembly.port}/v1/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await sign(tenantId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    return { status: response.status, body: (await response.json()) as RunBody }
  }

  beforeAll(async () => {
    acmeDir = mkdtempSync(join(tmpdir(), 'dsh-acme-'))
    globexDir = mkdtempSync(join(tmpdir(), 'dsh-globex-'))
    // Warm the tool-exec image so the first request's container start is not gated by a pull.
    spawnSync(runtime, ['pull', 'dsh-tool-exec:latest'])
    assembly = await assembleDemo({
      connectionString: postgresUrl!,
      jwtSecret: secret,
      jwtIssuer: issuer,
      port: 0,
      runtime: runtime as 'docker' | 'podman',
      tenants: [tenant('acme', acmeDir), tenant('globex', globexDir)],
    })
  }, 60000)

  afterAll(async () => {
    if (assembly !== undefined) await assembly.dispose()
    if (acmeDir !== undefined) rmSync(acmeDir, { recursive: true, force: true })
    if (globexDir !== undefined) rmSync(globexDir, { recursive: true, force: true })
  })

  it('runs each tenant tool call in its own container workspace', async () => {
    const acme = await run('acme')
    expect(acme.status).toBe(200)
    expect(acme.body.ok).toBe(true)
    expect(acme.body.result?.marker).toBe('acme')

    const globex = await run('globex')
    expect(globex.status).toBe(200)
    expect(globex.body.result?.marker).toBe('globex')
  }, 30000)

  it('keeps the two workspaces physically separate on the host', () => {
    expect(readFileSync(join(acmeDir, 'demo-tenant.txt'), 'utf8')).toBe('acme')
    expect(readFileSync(join(globexDir, 'demo-tenant.txt'), 'utf8')).toBe('globex')
  })

  it('isolates persisted sessions by tenant schema', async () => {
    const acmeSessions = await runWithTenant(tenant('acme', acmeDir), () => assembly.ctx.sessionPersistence.list())
    const globexSessions = await runWithTenant(tenant('globex', globexDir), () => assembly.ctx.sessionPersistence.list())
    expect(acmeSessions.some(header => String(header.id).startsWith('demo-acme-'))).toBe(true)
    expect(globexSessions.some(header => String(header.id).startsWith('demo-acme-'))).toBe(false)
  })

  it('rejects a credential minted for an unregistered tenant', async () => {
    const outsider = await run('outsider')
    expect(outsider.status).toBe(403)
    expect(outsider.body.error?.code).toBe('TENANT_UNKNOWN')
  })
})
