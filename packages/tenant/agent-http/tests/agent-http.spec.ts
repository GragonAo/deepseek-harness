import { describe, expect, it } from 'vitest'
import { Script } from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import { SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { SessionStore } from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { currentTenant, runWithTenant, runWithUser, TenantId, UserId } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantRegistry } from '@deepseek-ai/dsh-tenant'
import JwtTenantAuthenticator from '@deepseek-ai/dsh-tenant-auth-jwt'
import AgentHttp from '../src/index.ts'

const SECRET = new TextEncoder().encode('test-secret')
const ISSUER = 'agent-http-test'

function tenant(id: string): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/workspace/${id}`,
  }
}

async function issueToken(tenantId: string | undefined, subject = 'user-1'): Promise<string> {
  const payload: JWTPayload = { sub: subject }
  if (tenantId !== undefined) payload.tenantId = tenantId
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SECRET)
}

/**
 * Minimal gateway doubling the shared `ctx.apiProxy`. `session.list`/`search`
 * answer the served items verbatim (a naive single-user gateway leaks every
 * in-process session); `events.mux` replays the supplied frames. Both are the
 * surfaces the tenant carrier must scope.
 */
class FakeGateway extends Service {
  readonly tenantSeen: Array<string | undefined> = []
  listItems: Array<{ sessionId: string }> = []
  muxPayloads: Array<{ type: string; sessionId?: string }> = []
  hostPayloads: Array<Record<string, unknown>> = []

  constructor(ctx: Context) {
    super(ctx, 'apiProxy')
  }

  sessions = {
    list: async (r: { rpcId: unknown }) => {
      this.tenantSeen.push(currentTenant()?.id)
      return {
        rpcId: r.rpcId,
        result: {
          ok: true,
          value: { items: this.listItems.map(i => ({ sessionId: i.sessionId, updatedAt: 0, running: false, blank: true })) },
        },
      }
    },
    search: async (r: { rpcId: unknown }) => {
      return {
        rpcId: r.rpcId,
        result: { ok: true, value: { items: this.listItems.map(i => ({ sessionId: i.sessionId, snippet: 's' })), hasMore: false } },
      }
    },
  }

  events = {
    mux: (_request: unknown, _signal: AbortSignal) => this.muxStream(),
    host: (_request: unknown, _signal: AbortSignal) => this.hostStream(),
  }

  private async * muxStream(): AsyncIterable<unknown> {
    let n = 0
    for (const payload of this.muxPayloads) {
      yield { rpcId: `rpc-${n++}`, payload: payload as never }
    }
  }

  private async * hostStream(): AsyncIterable<unknown> {
    let n = 0
    for (const payload of this.hostPayloads) {
      yield { rpcId: `rpc-${n++}`, payload: payload as never }
    }
  }
}

async function boot(): Promise<{ ctx: Context; gateway: FakeGateway }> {
  const ctx = new Context()
  await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: 'test-secret' })
  await ctx.plugin(TenantRegistry)
  ctx.tenants.register(tenant('acme'))
  ctx.tenants.register(tenant('globex'))
  await ctx.plugin(SessionStore)
  const gateway = new FakeGateway(ctx)
  await ctx.plugin(AgentHttp)
  return { ctx, gateway }
}

function sessionListRequest(token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return new Request('http://localhost/api/session.list', {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
  })
}

function muxRequest(token: string): Request {
  return new Request('http://localhost/api/events.mux', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  })
}

function hostRequest(token: string): Request {
  return new Request('http://localhost/api/events.host', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  })
}

/** Create one live session under the named (tenant, user), returning its minted id. */
function createScopedSession(ctx: Context, id: string, user: string): string {
  return String(runWithTenant(tenant(id), () => runWithUser(UserId(user), () => ctx.sessions.create())).id)
}

describe('AgentHttp', () => {
  it('authenticates a bearer token and runs the gateway inside the resolved tenant', async () => {
    const { ctx, gateway } = await boot()
    try {
      const token = await issueToken('acme')
      const response = await ctx.agentHttp.fetch(sessionListRequest(token))
      expect(response.status).toBe(200)
      const body = await response.json() as { result?: { value?: { items?: unknown[] } } }
      expect(body.result?.value?.items).toEqual([])
      expect(gateway.tenantSeen).toEqual(['acme'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed on a missing credential', async () => {
    const { ctx } = await boot()
    try {
      const response = await ctx.agentHttp.fetch(sessionListRequest())
      expect(response.status).toBe(401)
      const body = await response.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe('MISSING_CREDENTIAL')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed on an invalid token', async () => {
    const { ctx } = await boot()
    try {
      const response = await ctx.agentHttp.fetch(sessionListRequest('not-a-jwt'))
      expect(response.status).toBe(401)
      const body = await response.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe('INVALID_TOKEN')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed on a credential for an unknown tenant', async () => {
    const { ctx } = await boot()
    try {
      const token = await issueToken('unknown')
      const response = await ctx.agentHttp.fetch(sessionListRequest(token))
      expect(response.status).toBe(403)
      const body = await response.json() as { error?: { code?: string } }
      expect(body.error?.code).toBe('TENANT_UNKNOWN')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed on a subject outside a tenant members list', async () => {
    const { ctx } = await boot()
    ctx.tenants.register({ ...tenant('restricted'), members: ['alice'] })
    try {
      const denial = await ctx.agentHttp.fetch(sessionListRequest(await issueToken('restricted', 'eve')))
      expect(denial.status).toBe(403)
      const denialBody = await denial.json() as { error?: { code?: string } }
      expect(denialBody.error?.code).toBe('NOT_A_MEMBER')

      const allowed = await ctx.agentHttp.fetch(sessionListRequest(await issueToken('restricted', 'alice')))
      expect(allowed.status).toBe(200)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('scopes session.list/search items to the authenticated (tenant, user)', async () => {
    const { ctx, gateway } = await boot()
    try {
      const acmeU1 = createScopedSession(ctx, 'acme', 'user-1')
      const acmeU2 = createScopedSession(ctx, 'acme', 'user-2')
      const globexU1 = createScopedSession(ctx, 'globex', 'user-1')
      gateway.listItems = [
        { sessionId: acmeU1 }, { sessionId: acmeU2 }, { sessionId: globexU1 }, { sessionId: 'cold-1' },
      ]

      const acmeUser1 = await ctx.agentHttp.fetch(sessionListRequest(await issueToken('acme', 'user-1')))
      const acmeUser1Body = await acmeUser1.json() as { result?: { value?: { items?: Array<{ sessionId: string }> } } }
      expect(acmeUser1Body.result?.value?.items?.map(i => i.sessionId)).toEqual([acmeU1, 'cold-1'])

      const acmeUser2 = await ctx.agentHttp.fetch(sessionListRequest(await issueToken('acme', 'user-2')))
      const acmeUser2Body = await acmeUser2.json() as { result?: { value?: { items?: Array<{ sessionId: string }> } } }
      expect(acmeUser2Body.result?.value?.items?.map(i => i.sessionId)).toEqual([acmeU2, 'cold-1'])

      const globexUser1 = await ctx.agentHttp.fetch(sessionListRequest(await issueToken('globex', 'user-1')))
      const globexUser1Body = await globexUser1.json() as { result?: { value?: { items?: Array<{ sessionId: string }> } } }
      expect(globexUser1Body.result?.value?.items?.map(i => i.sessionId)).toEqual([globexU1, 'cold-1'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('scopes the events.mux stream to the authenticated (tenant, user)', async () => {
    const { ctx, gateway } = await boot()
    try {
      const acmeU1 = createScopedSession(ctx, 'acme', 'user-1')
      const acmeU2 = createScopedSession(ctx, 'acme', 'user-2')
      const globexU1 = createScopedSession(ctx, 'globex', 'user-1')
      gateway.muxPayloads = [
        { type: 'session/subscribed', sessionId: acmeU1 },
        { type: 'session/subscribed', sessionId: acmeU2 },
        { type: 'session/subscribed', sessionId: globexU1 },
        { type: 'stream/error' },
      ]

      const response = await ctx.agentHttp.fetch(muxRequest(await issueToken('acme', 'user-1')))
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain(acmeU1)
      expect(text).not.toContain(acmeU2)
      expect(text).not.toContain(globexU1)
      expect(text).toContain('stream/error')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('scopes the events.host stream to the authenticated (tenant, user)', async () => {
    const { ctx, gateway } = await boot()
    try {
      const acmeU1 = createScopedSession(ctx, 'acme', 'user-1')
      const acmeU2 = createScopedSession(ctx, 'acme', 'user-2')
      const globexU1 = createScopedSession(ctx, 'globex', 'user-1')
      gateway.hostPayloads = [
        { type: 'host/session-added', sessionId: acmeU1, blank: true },
        { type: 'host/session-added', sessionId: acmeU2, blank: true },
        { type: 'host/session-added', sessionId: globexU1, blank: true },
        { type: 'host/archived-sessions-changed', archivedSessionIds: [acmeU1, acmeU2, globexU1, 'cold-1'] },
        { type: 'host/workspace-changed', workspace: { workspaceId: 'w1' } },
        { type: 'stream/error' },
      ]

      const response = await ctx.agentHttp.fetch(hostRequest(await issueToken('acme', 'user-1')))
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain(acmeU1)
      expect(text).not.toContain(acmeU2)
      expect(text).not.toContain(globexU1)
      expect(text).toContain('host/workspace-changed')
      expect(text).toContain('stream/error')

      const archived = text.split('\n\n')
        .map(unit => unit.startsWith('data: ') ? unit.slice('data: '.length) : undefined)
        .filter((unit): unit is string => unit !== undefined)
        .map(unit => JSON.parse(unit) as { payload?: { archivedSessionIds?: string[] } })
        .find(frame => frame.payload?.archivedSessionIds !== undefined)
      expect(archived?.payload?.archivedSessionIds).toEqual([acmeU1, 'cold-1'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the /api carrier route over HTTP when a webServer is present', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: 'test-secret' })
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    await ctx.plugin(SessionStore)
    const gateway = new FakeGateway(ctx)
    await ctx.plugin(AgentHttp)
    try {
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      const token = await issueToken('acme')
      const response = await fetch(`${origin}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { result?: { value?: { items?: unknown[] } } }
      expect(body.result?.value?.items).toEqual([])
      expect(gateway.tenantSeen).toEqual(['acme'])

      const missing = await fetch(`${origin}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'session.list', payload: {} }),
      })
      expect(missing.status).toBe(401)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the OpenAPI document and Swagger UI without auth', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: 'test-secret' })
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    await ctx.plugin(SessionStore)
    new FakeGateway(ctx)
    await ctx.plugin(AgentHttp)
    try {
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`

      const doc = await fetch(`${origin}/openapi.json`)
      expect(doc.status).toBe(200)
      const docBody = await doc.json() as { openapi?: string; paths?: Record<string, unknown> }
      expect(docBody.openapi).toBe('3.1.0')
      expect(docBody.paths?.['/api/tenant.admin.create']).toBeDefined()

      const ui = await fetch(`${origin}/swagger`)
      expect(ui.status).toBe(200)
      expect(ui.headers.get('content-type')).toContain('text/html')
      expect(await ui.text()).toContain('SwaggerUIBundle')

      const css = await fetch(`${origin}/swagger/swagger-ui.css`)
      expect(css.status).toBe(200)
      expect(css.headers.get('content-type')).toContain('text/css')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the discovery routes when openapi is disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: 'test-secret' })
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    await ctx.plugin(SessionStore)
    new FakeGateway(ctx)
    await ctx.plugin(AgentHttp, { openapi: false })
    try {
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      expect((await fetch(`${origin}/openapi.json`)).status).toBe(404)
      expect((await fetch(`${origin}/swagger`)).status).toBe(404)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the operator console without auth', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: 'test-secret' })
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    await ctx.plugin(SessionStore)
    new FakeGateway(ctx)
    await ctx.plugin(AgentHttp)
    try {
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      const page = await fetch(`${origin}/console`)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      const html = await page.text()
      // The page must drive the real wire contract, not a private surface.
      expect(html).toContain("rpc('tenant.admin.list'")
      expect(html).toContain("rpc('session.prompt'")
      expect(html).toContain("rpc('credentials.set'")
      expect(html).toContain("rpc('credentials.describe'")
      expect(html).toContain("rpc('llm.discoverModels'")
      expect(html).toContain("rpc('settings.update'")
      expect(html).toContain("fetch('/api/events.mux'")
      // Reads are value-free by contract: the page must never render a credential value back.
      expect(html).toContain('type="password"')

      // The page is one TypeScript template literal, so an escape written for the browser
      // (`'\n'` inside a quoted JS string) is consumed by the template instead and emits a
      // literal newline, breaking that string. Only parsing the emitted script catches it.
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
      expect(script).toBeDefined()
      expect(() => new Script(script ?? '')).not.toThrow()

      // Every id the script looks up must exist in the markup it shipped with.
      const lookedUp = new Set([...(script ?? '').matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))
      const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]))
      expect([...lookedUp].filter(id => !declared.has(id))).toEqual([])

      const rejected = await fetch(`${origin}/console`, { method: 'POST' })
      expect(rejected.status).toBe(405)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the console route when console is disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: 'test-secret' })
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    await ctx.plugin(SessionStore)
    new FakeGateway(ctx)
    await ctx.plugin(AgentHttp, { console: false })
    try {
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      expect((await fetch(`${origin}/console`)).status).toBe(404)
      // The discovery surface is independent of the console switch.
      expect((await fetch(`${origin}/openapi.json`)).status).toBe(200)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
