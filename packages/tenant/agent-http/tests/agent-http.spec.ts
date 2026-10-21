import { describe, expect, it } from 'vitest'
import { Script } from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import { SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { SessionStore, type Session } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { currentTenant, currentUser, runWithTenant, runWithUser, TenantId, UserId } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantRegistry } from '@deepseek-ai/dsh-tenant'
import JwtTenantAuthenticator from '@deepseek-ai/dsh-tenant-auth-jwt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import TenantQuestionService from '@deepseek-ai/dsh-tenant-questions'
import * as TenantQuestionInvariant from '@deepseek-ai/dsh-tenant-questions/invariant'
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
  /** Ids a `session.delete` reached this gateway with, in order. */
  readonly deleteSeen: string[] = []

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
    delete: async (r: { rpcId: unknown; payload: { sessionId: string } }) => {
      this.deleteSeen.push(r.payload.sessionId)
      return { rpcId: r.rpcId, result: { ok: true, value: { deleted: true as const } } }
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

function sessionSearchRequest(token: string, query: string): Request {
  return new Request('http://localhost/api/session.search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r-search', method: 'session.search', payload: { query } }),
  })
}

function sessionDeleteRequest(token: string, sessionId: string): Request {
  return new Request('http://localhost/api/session.delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r-delete',
      method: 'session.delete',
      payload: { sessionId },
    }),
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

/**
 * A durable store doubling the tenant-keyed persistence provider: `list()`
 * answers only the ambient (tenant, user)'s records, exactly as
 * `session-persistence-postgres` resolves them inside that tenant's schema.
 */
class FakePersistence extends Service {
  readonly records = new Map<string, { tenant: string; user: string }>()

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  list = async (): Promise<Array<{ id: string }>> => {
    const id = currentTenant()?.id
    const user = currentUser()
    return [...this.records.entries()]
      .filter(([, owner]) => owner.tenant === String(id) && owner.user === user)
      .map(([sessionId]) => ({ id: sessionId }))
  }
}

function addressedRequest(method: string, token: string, sessionId: string): Request {
  return new Request(`http://localhost/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r-owner',
      method,
      payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
    }),
  })
}

describe('AgentHttp session ownership', () => {
  it('answers a live session another tenant owns with session-not-found', async () => {
    const { ctx } = await boot()
    const foreign = createScopedSession(ctx, 'globex', 'user-1')
    const body = await (await ctx.agentHttp.fetch(addressedRequest('session.prompt', await issueToken('acme'), foreign))).json() as {
      result: { ok: boolean; error?: { code: string; details: { sessionId: string } } }
    }
    expect(body.result.ok).toBe(false)
    expect(body.result.error?.code).toBe('session-not-found')
    expect(body.result.error?.details.sessionId).toBe(foreign)
  })

  it('leaves the owning tenant its own live session', async () => {
    const { ctx } = await boot()
    const own = createScopedSession(ctx, 'acme', 'user-1')
    const response = await ctx.agentHttp.fetch(addressedRequest('session.prompt', await issueToken('acme'), own))
    expect(await response.text()).not.toContain('session-not-found')
  })

  it('resolves a cold session from the durable store, not from live ownership', async () => {
    const { ctx } = await boot()
    const persistence = new FakePersistence(ctx)
    persistence.records.set('session-cold-acme', { tenant: 'acme', user: 'user-1' })
    const own = await ctx.agentHttp.fetch(addressedRequest('session.prompt', await issueToken('acme'), 'session-cold-acme'))
    expect(await own.text()).not.toContain('session-not-found')
    const foreign = await ctx.agentHttp.fetch(addressedRequest('session.prompt', await issueToken('globex'), 'session-cold-acme'))
    const body = await foreign.json() as { result: { error?: { code: string } } }
    expect(body.result.error?.code).toBe('session-not-found')
  })

  it('refuses an id no record in the ambient tenant owns while a store is mounted', async () => {
    const { ctx } = await boot()
    new FakePersistence(ctx)
    const body = await (await ctx.agentHttp.fetch(addressedRequest('session.history', await issueToken('acme'), 'session-unknown'))).json() as {
      result: { error?: { code: string } }
    }
    expect(body.result.error?.code).toBe('session-not-found')
  })
})

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

  it('refuses to delete a session another (tenant, user) owns without reaching the gateway', async () => {
    const { ctx, gateway } = await boot()
    try {
      const acmeOwn = createScopedSession(ctx, 'acme', 'user-1')
      const acmeOtherUser = createScopedSession(ctx, 'acme', 'user-2')
      const globexOwn = createScopedSession(ctx, 'globex', 'user-1')

      const foreign = await ctx.agentHttp.fetch(sessionDeleteRequest(await issueToken('globex'), acmeOwn))
      const foreignBody = await foreign.json() as { result: { ok: boolean; error?: { code: string; details: { sessionId: string } } } }
      expect(foreignBody.result.ok).toBe(false)
      expect(foreignBody.result.error?.code).toBe('session-not-found')
      expect(foreignBody.result.error?.details.sessionId).toBe(acmeOwn)
      // Same tenant, other subject: the id is not this caller's either.
      const sameTenant = await ctx.agentHttp.fetch(sessionDeleteRequest(await issueToken('acme', 'user-2'), acmeOwn))
      expect((await sameTenant.json() as { result: { error?: { code: string } } }).result.error?.code)
        .toBe('session-not-found')
      expect(gateway.deleteSeen).toEqual([])

      // The owner's own delete does reach the gateway, so the refusals above are
      // the ownership fence and not this route failing closed for everyone.
      const own = await ctx.agentHttp.fetch(sessionDeleteRequest(await issueToken('acme'), acmeOwn))
      expect(await own.json()).toMatchObject({ result: { ok: true, value: { deleted: true } } })
      const globexSelf = await ctx.agentHttp.fetch(sessionDeleteRequest(await issueToken('globex'), globexOwn))
      expect(await globexSelf.json()).toMatchObject({ result: { ok: true, value: { deleted: true } } })
      expect(gateway.deleteSeen).toEqual([acmeOwn, globexOwn])
      expect(acmeOtherUser).not.toBe(acmeOwn)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hides this tenant’s archived sessions from list/search without masking the tenant scope', async () => {
    const { ctx, gateway } = await boot()
    try {
      const archived = createScopedSession(ctx, 'acme', 'user-1')
      const live = createScopedSession(ctx, 'acme', 'user-1')
      const otherUser = createScopedSession(ctx, 'acme', 'user-2')
      const globex = createScopedSession(ctx, 'globex', 'user-1')
      gateway.listItems = [
        { sessionId: archived }, { sessionId: live }, { sessionId: otherUser }, { sessionId: globex },
      ]
      // The archive set the ambient tenant's workspace registry reports.
      ctx.provide('workspaceRegistry', { archivedSessionIds: [archived] } as never)

      const listed = await ctx.agentHttp.fetch(sessionListRequest(await issueToken('acme', 'user-1')))
      const listedBody = await listed.json() as { result?: { value?: { items?: Array<{ sessionId: string }> } } }
      expect(listedBody.result?.value?.items?.map(i => i.sessionId)).toEqual([live])

      const searched = await ctx.agentHttp.fetch(sessionSearchRequest(await issueToken('acme', 'user-1'), 's'))
      const searchedBody = await searched.json() as { result?: { value?: { items?: Array<{ sessionId: string }> } } }
      expect(searchedBody.result?.value?.items?.map(i => i.sessionId)).toEqual([live])

      // Another tenant's own view is filtered by ownership, not by acme's archive
      // set: its session survives, and acme's archived id is not its business.
      const globexListed = await ctx.agentHttp.fetch(sessionListRequest(await issueToken('globex', 'user-1')))
      const globexBody = await globexListed.json() as { result?: { value?: { items?: Array<{ sessionId: string }> } } }
      expect(globexBody.result?.value?.items?.map(i => i.sessionId)).toEqual([globex])
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
      expect(docBody.paths?.['/api/session.create']).toBeDefined()

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
      // The page must drive the real wire contracts, not a private surface: the
      // tenant tab talks to the management carrier's own prefix.
      expect(html).toContain("admin('tenants.list'")
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

/**
 * Boot the business surface over the question channel: the same carrier and
 * authority as the rest of `/api`, plus the seam, the channel, and one live
 * session with an open turn asking a question.
 */
async function bootQuestions(options: { channel?: boolean; invariant?: boolean } = {}): Promise<{
  ctx: Context
  token: string
  otherToken: string
  session: Session
  sessionId: string
  asked: Promise<unknown>
  live: () => unknown[]
}> {
  const ctx = new Context()
  await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: 'test-secret' })
  await ctx.plugin(TenantRegistry)
  ctx.tenants.register(tenant('acme'))
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  new FakeGateway(ctx)
  await ctx.plugin(UserQuestionService)
  if (options.invariant === true) {
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(TenantQuestionInvariant)
  }
  if (options.channel !== false) await ctx.plugin(TenantQuestionService)
  await ctx.plugin(AgentHttp)
  const scope = { tenant: tenant('acme'), user: UserId('user-1') }
  const session = runWithTenant(scope.tenant, () => runWithUser(scope.user, () => ctx.sessions.create()))
  const agent = { id: session.id, session } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  session.append('turn/start', { turn: 1 })
  const asked = runWithTenant(scope.tenant, () => runWithUser(scope.user, () => ctx.userQuestions.ask({
    agent,
    questions: [{ id: 'target', question: 'Which target?', options: [{ label: 'staging' }, { label: 'production' }] }],
  })))
  // Disposal aborts whatever a test leaves unanswered; a test that means to
  // assert that rejection awaits this same promise.
  void asked.catch(() => undefined)
  return {
    ctx,
    token: await issueToken('acme'),
    otherToken: await issueToken('acme', 'user-2'),
    session,
    sessionId: String(session.id),
    asked,
    live: () => runWithTenant(tenant('acme'), () => runWithUser(UserId('user-1'), () => ctx.tenantQuestions.list())),
  }
}

/** One client-request envelope over the question channel. */
function questionRequest(method: string, payload: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return new Request(`http://localhost/api/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'client-request', rpcId: 'q1', method, payload }),
  })
}

describe('AgentHttp question channel', () => {
  it('admits the answer with the same authority as the rest of the business surface', async () => {
    const h = await bootQuestions()
    try {
      const denial = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.list', {}, undefined))
      expect(denial.status).toBe(401)
      expect(await denial.json()).toMatchObject({ error: { code: 'MISSING_CREDENTIAL' } })
      expect(h.live()).toHaveLength(1)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('lists the waiting question and answers it', async () => {
    const h = await bootQuestions()
    try {
      const listed = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.list', {}, h.token))
      expect(listed.status).toBe(200)
      const listBody = await listed.json() as { rpcId: string; result: { ok: boolean; value: unknown[] } }
      expect(listBody.rpcId).toBe('q1')
      expect(listBody.result.ok).toBe(true)
      expect(listBody.result.value).toHaveLength(1)

      const answered = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.answer', {
        sessionId: h.sessionId,
        questionId: (listBody.result.value[0] as { id: string }).id,
        answer: { answers: [{ id: 'target', selected: ['production'] }] },
      }, h.token))
      expect(answered.status).toBe(200)
      expect(await answered.json()).toMatchObject({ result: { ok: true } })
      await expect(h.asked).resolves.toEqual({ answers: [{ id: 'target', selected: ['production'] }] })
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('refuses an answer from another subject in the same tenant', async () => {
    const h = await bootQuestions()
    try {
      const listed = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.list', {}, h.token))
      const value = (await listed.json() as { result: { value: Array<{ id: string }> } }).result.value
      const response = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.answer', {
        sessionId: h.sessionId,
        questionId: value[0]?.id,
        answer: { answers: [{ id: 'target', selected: ['production'] }] },
      }, h.otherToken))

      // A business error travels in the 200 ServerResponse body, as the gateway's do.
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        result: { ok: false, error: { code: 'bad-request', message: 'invalid payload for tenantQuestion.answer' } },
      })
      // The refusal changed nothing: the ask still waits for its own subject.
      expect(h.live()).toHaveLength(1)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('rejects a malformed payload with the field-level detail', async () => {
    const h = await bootQuestions()
    try {
      const response = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.answer', {
        sessionId: h.sessionId,
        questionId: 'not-asked',
        answer: { answers: [{ id: 'target', selected: ['production'] }] },
      }, h.token))

      expect(response.status).toBe(200)
      const body = await response.json() as { result: { error: { details: { issues: unknown[] } } } }
      expect(body.result.error.details.issues).toHaveLength(1)
      expect(h.live()).toHaveLength(1)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('applies the gateway’s carrier statuses and envelope rules to the same paths', async () => {
    const h = await bootQuestions()
    try {
      const wrongType = new Request('http://localhost/api/tenantQuestion.list', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'text/plain' },
        body: '{}',
      })
      expect((await h.ctx.agentHttp.fetch(wrongType)).status).toBe(415)

      const notJson = new Request('http://localhost/api/tenantQuestion.list', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
        body: 'not json',
      })
      expect((await h.ctx.agentHttp.fetch(notJson)).status).toBe(400)

      // An unreadable envelope is a 200 bad-request ServerResponse, not a carrier failure.
      const badEnvelope = await h.ctx.agentHttp.fetch(new Request('http://localhost/api/tenantQuestion.list', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      }))
      expect(badEnvelope.status).toBe(200)
      expect(await badEnvelope.json()).toMatchObject({
        rpcId: 'invalid-request',
        result: { ok: false, error: { code: 'bad-request', message: 'invalid client-request message' } },
      })

      const mismatched = await h.ctx.agentHttp.fetch(new Request('http://localhost/api/tenantQuestion.answer', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'q2', method: 'tenantQuestion.list', payload: {} }),
      }))
      expect(mismatched.status).toBe(200)
      expect(await mismatched.json()).toMatchObject({
        rpcId: 'q2',
        result: { ok: false, error: { message: 'method "tenantQuestion.list" does not match path "tenantQuestion.answer"' } },
      })

      // A non-POST on a channel path stays the gateway's to answer: unknown route.
      const get = await h.ctx.agentHttp.fetch(new Request('http://localhost/api/tenantQuestion.list', {
        method: 'GET',
        headers: { authorization: `Bearer ${h.token}` },
      }))
      expect(get.status).toBe(404)

      // A salvageable rpcId is echoed even when the envelope itself is unusable.
      const salvageable = await h.ctx.agentHttp.fetch(new Request('http://localhost/api/tenantQuestion.list', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'q3', method: 42, payload: {} }),
      }))
      expect(await salvageable.json()).toMatchObject({ rpcId: 'q3', result: { ok: false, error: { code: 'bad-request' } } })

      // The channel answers under its own prefix only: the same method name on any
      // other path is the gateway's request, not an answer hole.
      const outsideThePrefix = await h.ctx.agentHttp.fetch(new Request('http://localhost/tenantQuestion.list', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'q4', method: 'tenantQuestion.list', payload: {} }),
      }))
      expect(outsideThePrefix.status).toBe(404)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('reports a channel failure the envelope cannot describe as a carrier crash', async () => {
    const h = await bootQuestions({ invariant: true })
    try {
      // The turn ends between the ask and the answer, so the audit invariant refuses
      // the resolution and the channel fails with something other than a payload
      // rejection — the carrier's own 500, not a silent success.
      h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const response = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.answer', {
        sessionId: h.sessionId,
        questionId: (h.live()[0] as { id: string }).id,
        answer: { answers: [{ id: 'target', selected: ['production'] }] },
      }, h.token))

      expect(response.status).toBe(500)
      expect(await response.text()).toContain('handler failure')
      // The model is not left waiting for a decision the log will never carry.
      await expect(h.asked).rejects.toMatchObject({ message: expect.stringMatching(/outside any open turn/) as unknown as string })
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('reports an unmounted channel instead of silently dropping the method', async () => {
    const h = await bootQuestions({ channel: false })
    try {
      const response = await h.ctx.agentHttp.fetch(questionRequest('tenantQuestion.list', {}, h.token))
      expect(response.status).toBe(503)
      expect(await response.text()).toContain('tenantQuestion.list')
      // The seam itself is still mounted; nothing answered the question, so the
      // model's own ask fails rather than waiting forever.
      expect(h.ctx.get('userQuestions')).toBeDefined()
      expect(h.ctx.get('tenantQuestions')).toBeUndefined()
      await expect(h.asked).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    } finally {
      await h.ctx.fiber.dispose()
    }
  })
})
