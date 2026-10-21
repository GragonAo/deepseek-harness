import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { TenantId } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantRegistry } from '@deepseek-ai/dsh-tenant'
import { TenantAuthError } from '@deepseek-ai/dsh-tenant-auth'
import TenantFsHttp from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * A bearer credential in this suite's own notation: `<subject>@<tenant>` proves
 * both, a bare `<subject>` proves no tenant — the case the surface must refuse.
 * The real provider is `@deepseek-ai/dsh-tenant-auth-jwt`; what this package owns
 * is what happens after a principal is proven, so the principal is proven here by
 * the simplest carrier that reaches the same service.
 */
class FakeAuth extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tenantAuth')
  }

  async authenticate(header: string): Promise<{ subject: string; tenantId: string | undefined; scopes: string[] }> {
    const credential = header.replace(/^Bearer\s+/i, '').trim()
    if (credential.length === 0) throw new TenantAuthError('MISSING_CREDENTIAL', '缺少凭据')
    const [subject, tenantId] = credential.split('@')
    if (subject === undefined || subject.length === 0) throw new TenantAuthError('INVALID_TOKEN', '凭据不可解析')
    return { subject, tenantId, scopes: [] }
  }
}

/** One deployment root and the tenant whose workspace it holds. */
interface Deployment {
  root: string
  workspaceRoot: string
  usersRoot: string
  systemRoot: string
}

function layout(): Deployment {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fs-http-'))
  const workspaceRoot = join(root, 'ws')
  const usersRoot = join(root, 'users')
  const systemRoot = join(root, 'sys')
  mkdirSync(join(workspaceRoot, 'work'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'users', 'user-1', 'work'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'users', 'user-1', 'sessions', 'session-1'), { recursive: true })
  mkdirSync(join(usersRoot, 'user-1', 'work'), { recursive: true })
  mkdirSync(join(systemRoot, 'skills'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'work', 'case-plan.md'), '# 案件计划\n')
  writeFileSync(join(workspaceRoot, 'users', 'user-1', 'work', 'notes.md'), '# 笔记\n')
  writeFileSync(join(workspaceRoot, 'users', 'user-1', 'sessions', 'session-1', 'a.md'), '# 会话笔记\n')
  writeFileSync(join(usersRoot, 'user-1', 'work', 'global.md'), '# 全局\n')
  writeFileSync(join(systemRoot, 'skills', 'readme.md'), '# 系统\n')
  return { root, workspaceRoot, usersRoot, systemRoot }
}


/** Mount the surface over one deployment, registering the tenant its workspace belongs to. */
async function boot(
  deployment: Deployment,
  options: { members?: string[]; config?: Config; web?: boolean } = {},
): Promise<{ ctx: Context; token: string }> {
  const ctx = new Context()
  if (options.web === true) await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  new FakeAuth(ctx)
  await ctx.plugin(TenantRegistry)
  const tenant: Tenant = {
    id: TenantId('acme'),
    name: 'acme',
    dataRoot: join(deployment.root, 'data'),
    workspaceRoot: deployment.workspaceRoot,
    ...(options.members === undefined ? {} : { members: options.members }),
  }
  ctx.tenants.register(tenant)
  await ctx.plugin(TenantFsHttp, {
    usersRoot: deployment.usersRoot,
    systemRoot: deployment.systemRoot,
    ...options.config,
  })
  return { ctx, token: 'user-1@acme' }
}

function request(token: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return new Request(new URL(path, 'http://dsh.internal'), { ...init, headers })
}

describe('file surface', () => {
  it('reads one file from each scope, naming the bytes and the version', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      const cases: [string, string][] = [
        ['# 案件计划\n', '/files/case/case-plan.md'],
        ['# 笔记\n', '/files/user/notes.md'],
        ['# 会话笔记\n', '/files/session/session-1/a.md'],
        ['# 全局\n', '/files/global/global.md'],
        ['# 系统\n', '/files/system/skills/readme.md'],
      ]
      for (const [expected, path] of cases) {
        const response = await ctx.tenantFsHttp.fetch(request(token, path))
        expect(response.status, path).toBe(200)
        expect(await response.text(), path).toBe(expected)
        expect(response.headers.get('etag'), path).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
        expect(response.headers.get('content-type'), path).toBe('text/markdown; charset=utf-8')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers HEAD with the version and no body, and 304 for a version the client already has', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      const head = await ctx.tenantFsHttp.fetch(request(token, '/files/user/notes.md', { method: 'HEAD' }))
      expect(head.status).toBe(200)
      expect(head.body).toBeNull()
      expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('# 笔记\n')))
      const etag = head.headers.get('etag')!

      const cached = await ctx.tenantFsHttp.fetch(
        request(token, '/files/user/notes.md', { headers: { 'if-none-match': etag } }),
      )
      expect(cached.status).toBe(304)
      expect(cached.body).toBeNull()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes a file the model then reads, and refuses a write whose precondition is stale', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      const body = Buffer.from('第一版')
      const created = await ctx.tenantFsHttp.fetch(
        request(token, '/files/user/report.docx', { method: 'PUT', body }),
      )
      expect(created.status).toBe(200)
      expect(readFileSync(join(deployment.workspaceRoot, 'users', 'user-1', 'work', 'report.docx')).toString()).toBe('第一版')
      const first = await created.json() as { etag: string; size: number }
      expect(first.size).toBe(body.byteLength)

      // The version the client read is the version it may replace.
      const updated = await ctx.tenantFsHttp.fetch(
        request(token, '/files/user/report.docx', { method: 'PUT', body: Buffer.from('第二版'), headers: { 'if-match': first.etag } }),
      )
      expect(updated.status).toBe(200)
      const second = await updated.json() as { etag: string }
      expect(second.etag).not.toBe(first.etag)

      // Writing again with the stale version must lose, not overwrite the winner.
      const stale = await ctx.tenantFsHttp.fetch(
        request(token, '/files/user/report.docx', { method: 'PUT', body: Buffer.from('第三版'), headers: { 'if-match': first.etag } }),
      )
      expect(stale.status).toBe(412)
      expect((await stale.json() as { error: { code: string } }).error.code).toBe('file-conflict')
      expect(readFileSync(join(deployment.workspaceRoot, 'users', 'user-1', 'work', 'report.docx')).toString()).toBe('第二版')

      // The model's next read sees the client's bytes: one file, one version.
      const read = await ctx.tenantFsHttp.fetch(request(token, '/files/user/report.docx'))
      expect(await read.text()).toBe('第二版')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('requires If-Match: * to name a file that exists', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      const absent = await ctx.tenantFsHttp.fetch(
        request(token, '/files/user/absent.txt', { method: 'PUT', body: Buffer.from('x'), headers: { 'if-match': '*' } }),
      )
      expect(absent.status).toBe(412)
      const present = await ctx.tenantFsHttp.fetch(
        request(token, '/files/user/notes.md', { method: 'PUT', body: Buffer.from('y'), headers: { 'if-match': '*' } }),
      )
      expect(present.status).toBe(200)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a write into every read-only scope', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      for (const path of ['/files/case/case-plan.md', '/files/global/global.md', '/files/system/skills/readme.md']) {
        const response = await ctx.tenantFsHttp.fetch(request(token, path, { method: 'PUT', body: Buffer.from('x') }))
        expect(response.status, path).toBe(403)
        expect((await response.json() as { error: { code: string } }).error.code, path).toBe('file-readonly')
      }
      expect(readFileSync(join(deployment.workspaceRoot, 'work', 'case-plan.md')).toString()).toBe('# 案件计划\n')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists a directory with an ETag beside each file, so a client can write without a HEAD', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      const response = await ctx.tenantFsHttp.fetch(request(token, '/files/user'))
      expect(response.status).toBe(200)
      const listing = await response.json() as {
        scope: string
        path: string
        writable: boolean
        entries: { name: string; type: string; size?: number; etag?: string }[]
      }
      expect(listing.scope).toBe('user')
      expect(listing.path).toBe('')
      expect(listing.writable).toBe(true)
      expect(listing.entries.map(entry => entry.name)).toEqual(['notes.md'])
      expect(listing.entries[0]).toMatchObject({ type: 'file', size: Buffer.byteLength('# 笔记\n') })
      expect(listing.entries[0]!.etag).toMatch(/^"/)

      // A write in flight is not a listing entry: the temp name never surfaces.
      writeFileSync(join(deployment.workspaceRoot, 'users', 'user-1', 'work', '.notes.md.dsh-tmp.abcdef'), 'x')
      const after = await ctx.tenantFsHttp.fetch(request(token, '/files/user'))
      const names = (await after.json() as { entries: { name: string }[] }).entries.map(entry => entry.name)
      expect(names).toEqual(['notes.md'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists a subdirectory named by the query string', async () => {
    const deployment = layout()
    mkdirSync(join(deployment.workspaceRoot, 'users', 'user-1', 'sessions', 'session-1', 'out'))
    writeFileSync(join(deployment.workspaceRoot, 'users', 'user-1', 'sessions', 'session-1', 'out', 'x.md'), '# x\n')
    const { ctx, token } = await boot(deployment)
    try {
      const response = await ctx.tenantFsHttp.fetch(request(token, '/files/session?path=session-1/out'))
      expect(response.status).toBe(200)
      const listing = await response.json() as { path: string; entries: { name: string }[] }
      expect(listing.path).toBe('session-1/out')
      expect(listing.entries.map(entry => entry.name)).toEqual(['x.md'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a session directory that does not exist, so a write cannot mint one', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      const ghost = await ctx.tenantFsHttp.fetch(
        request(token, '/files/session/ghost/x.md', { method: 'PUT', body: Buffer.from('x') }),
      )
      expect(ghost.status).toBe(404)
      expect((await ghost.json() as { error: { code: string } }).error.code).toBe('file-session-unknown')
      const bare = await ctx.tenantFsHttp.fetch(
        request(token, '/files/session/session-1', { method: 'PUT', body: Buffer.from('x') }),
      )
      expect(bare.status).toBe(400)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers 409 when a read or a listing names the other kind of entry', async () => {
    const deployment = layout()
    mkdirSync(join(deployment.workspaceRoot, 'users', 'user-1', 'work', 'dir'))
    const { ctx, token } = await boot(deployment)
    try {
      const readDir = await ctx.tenantFsHttp.fetch(request(token, '/files/user/dir'))
      expect(readDir.status).toBe(409)
      expect((await readDir.json() as { error: { code: string } }).error.code).toBe('file-is-directory')
      const listFile = await ctx.tenantFsHttp.fetch(request(token, '/files/user?path=notes.md'))
      expect(listFile.status).toBe(409)
      expect((await listFile.json() as { error: { code: string } }).error.code).toBe('file-not-directory')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a traversal attempt inside the scope root', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      // `..%2F` survives URL normalization as one segment; decoded it holds a
      // separator, which no scope accepts.
      const escaped = await ctx.tenantFsHttp.fetch(request(token, '/files/user/..%2F..%2Fcase/case-plan.md'))
      expect(escaped.status).toBe(400)
      expect((await escaped.json() as { error: { code: string } }).error.code).toBe('file-path-invalid')
      const unknown = await ctx.tenantFsHttp.fetch(request(token, '/files/workspace/notes.md'))
      expect(unknown.status).toBe(404)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers 404 for a missing file and 405 for a method the surface does not serve', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment)
    try {
      const missing = await ctx.tenantFsHttp.fetch(request(token, '/files/user/none.md'))
      expect(missing.status).toBe(404)
      expect((await missing.json() as { error: { code: string } }).error.code).toBe('file-not-found')
      const refused = await ctx.tenantFsHttp.fetch(request(token, '/files/user/notes.md', { method: 'DELETE' }))
      expect(refused.status).toBe(405)
      expect(refused.headers.get('allow')).toBe('GET, HEAD, PUT')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers 413 for a body above the configured cap', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment, { config: { maxBytes: 8 } })
    try {
      const response = await ctx.tenantFsHttp.fetch(
        request(token, '/files/user/big.md', { method: 'PUT', body: Buffer.from('0123456789') }),
      )
      expect(response.status).toBe(413)
      expect((await response.json() as { error: { code: string } }).error.code).toBe('file-too-large')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed without a tenant-scoped credential, and for a subject outside the members list', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment, { members: ['alice'] })
    try {
      const platform = 'user-1'
      const refused = await ctx.tenantFsHttp.fetch(request(platform, '/files/user/notes.md'))
      expect(refused.status).toBe(401)
      expect(refused.headers.get('www-authenticate')).toBe('Bearer')

      const anonymous = await ctx.tenantFsHttp.fetch(new Request(new URL('/files/user/notes.md', 'http://dsh.internal')))
      expect(anonymous.status).toBe(401)

      const outsider = await ctx.tenantFsHttp.fetch(request(token, '/files/user/notes.md'))
      expect(outsider.status).toBe(403)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the same surface over HTTP when a webServer is present', async () => {
    const deployment = layout()
    const { ctx, token } = await boot(deployment, { web: true })
    try {
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      const read = await fetch(`${origin}/files/case/case-plan.md`, { headers: { authorization: `Bearer ${token}` } })
      expect(read.status).toBe(200)
      expect(await read.text()).toBe('# 案件计划\n')

      const written = await fetch(`${origin}/files/user/over-http.md`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: '正文',
      })
      expect(written.status).toBe(200)
      expect(readFileSync(join(deployment.workspaceRoot, 'users', 'user-1', 'work', 'over-http.md')).toString()).toBe('正文')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a token whose tenant is not registered', async () => {
    const deployment = layout()
    const { ctx } = await boot(deployment)
    try {
      const other = await ctx.tenantFsHttp.fetch(
        request('user-1@globex', '/files/user/notes.md'),
      )
      expect(other.status).toBe(403)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
