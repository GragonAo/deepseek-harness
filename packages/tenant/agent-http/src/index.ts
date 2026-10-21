/**
 * Multi-tenant agent HTTP carrier (`ctx.agentHttp`): wraps the existing
 * single-tenant gateway (`ctx.apiProxy` via `toFetchHandler`) with bearer
 * authentication and request-scoped tenant + user authority. Every request
 * verifies a credential through `ctx.tenantAuth`, resolves the tenant and
 * checks membership through `ctx.tenants.resolveMember`, and enters
 * `runWithTenant` + `runWithUser` before delegating the whole Request, so the
 * tenant- and user-scoped providers behind the unary RPC methods
 * (`session-persistence-postgres`, `subprocess-container`, `fs-container`,
 * `container-docker`) resolve through `requireTenant()` / `requireUser()`
 * inside that authority.
 *
 * The carrier holds no agent or session state: it is a pure
 * Request -> Response function over the shared gateway, so replicas are
 * interchangeable and a cold session is resumed by the gateway itself.
 *
 * The one shared gateway is single-tenant in its visibility, so the carrier
 * also scopes every surface that names a session: `session.list` /
 * `session.search` items, the session-scoped frames on the `events.mux` /
 * `events.host` streams, and each RPC method addressed by an existing
 * `sessionId`. A live owner this carrier observed decides on its own — this
 * subject is admitted, another is answered `session-not-found`; an id no live
 * owner claims must appear in the ambient (tenant, user)'s durable records,
 * which `session-persistence-postgres` resolves inside that tenant's schema, so
 * a session another tenant created is refused live or cold and a carrier
 * restart cannot widen visibility. An unclaimed id with no store to vouch for
 * it is refused rather than admitted.
 *
 * When a `webServer` service is present, the carrier also registers the
 * `/api` prefix route (a fetch bridge replacing the single-user
 * `client-connection` trust fence), so `dsh web` can serve the multi-tenant
 * API over HTTP without any other carrier. The same injection contributes the
 * unauthenticated discovery surfaces: `/openapi.json` + `/swagger` (the wire
 * reference) and `/console` (a self-contained operator page for tenant
 * administration and the session lifecycle).
 *
 * The carrier also answers the question channel's own methods
 * (`@deepseek-ai/dsh-tenant-questions`'s `TENANT_QUESTION_METHODS`) in place of
 * the gateway, whose method map is closed and shared by every deployment: a
 * multi-tenant business client asks `POST /api/tenantQuestion.answer` to answer
 * a question the model asked, under this same authority.
 *
 * @module @deepseek-ai/dsh-agent-http
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { clientRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { bridgeFetchRequest } from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { ZodError } from 'zod'
import { TENANT_QUESTION_METHODS } from '@deepseek-ai/dsh-tenant-questions'
import type { TenantQuestionMethod } from '@deepseek-ai/dsh-tenant-questions'
import { swaggerRoutes } from './openapi-route.ts'
import { consoleRoutes } from './console.ts'
import { currentTenant, currentUser, runWithScopes, runWithTenant, runWithUser, TenantError, UserId } from '@deepseek-ai/dsh-tenant'
import type { Tenant, TenantId } from '@deepseek-ai/dsh-tenant'
import { TenantAuthError } from '@deepseek-ai/dsh-tenant-auth'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentHttp: AgentHttp
  }
}

/** Prefix the carrier serves; the gateway's handler matches this literal, so it is not configurable. */
const API_PATH = '/api'

/**
 * Default carrier cap for all HTTP RPC bodies, matching the single-user
 * carrier: sized for the default aggregate image limit after base64 expansion.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 160 * 1024 * 1024

/** Default for `openapi`: serve the discovery surface out of the box. */
const DEFAULT_OPENAPI = true

/** Default for `console`: serve the operator console out of the box. */
const DEFAULT_CONSOLE = true

/**
 * RPC methods addressed by an existing `sessionId` (the `session.*` entries of
 * the gateway's closed method map whose request payload names one session).
 * Each is resolved against the ambient (tenant, user) before the gateway runs
 * it, so a foreign or unknown id never reaches the shared agent registry.
 */
const SESSION_ADDRESSED_METHODS: ReadonlySet<string> = new Set([
  'session.history',
  'session.models',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
  'session.delete',
])

/** Carrier configuration. */
export interface Config {
  /** Maximum buffered request body bytes before the route answers 413. */
  maxRequestBodyBytes?: number
  /** Serve `GET /openapi.json` and the `/swagger` UI when a `webServer` is present. */
  openapi?: boolean
  /** Serve the `/console` operator page when a `webServer` is present. */
  console?: boolean
}

/** Multi-tenant carrier registered as `ctx.agentHttp`. */
export class AgentHttp extends Service {
  static inject = ['tenantAuth', 'tenants', 'apiProxy']
  static Config: z<Config> = z.object({
    maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
    openapi: z.boolean().default(DEFAULT_OPENAPI),
    console: z.boolean().default(DEFAULT_CONSOLE),
  })

  /** Live sessionId -> owning (tenant, user), fed by `session/created` under the ambient scope. */
  private readonly sessionScopes = new Map<string, { tenant: string; user: UserId }>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'agentHttp')
    ctx.effect(() => ctx.on('session/created', (session) => {
      const tenant = currentTenant()
      const user = currentUser()
      if (tenant !== undefined && user !== undefined) {
        this.sessionScopes.set(String(session.id), { tenant: String(tenant.id), user })
      }
    }, { global: true }), 'agentHttp: session ownership')
    ctx.effect(() => ctx.on('session/disposed', (session) => {
      this.sessionScopes.delete(String(session.id))
    }, { global: true }), 'agentHttp: session ownership release')
    // The physical carrier route is an optional-server contribution: absent a
    // webServer (headless/test contexts) the carrier still runs for direct
    // `fetch` callers; present one, and it owns the /api prefix in place of the
    // single-user client-connection trust fence.
    ctx.inject(['webServer'], (webCtx) => {
      const route: WebRoute = {
        kind: 'prefix',
        path: API_PATH,
        handler: (req, res) => bridgeFetchRequest(
          req, res, { fetch: request => this.fetch(request) },
          this.config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
        ),
      }
      webCtx.effect(() => webCtx.webServer.register(route), 'agent-http: /api carrier route')
      if (this.config.openapi) {
        for (const swaggerRoute of swaggerRoutes()) {
          webCtx.effect(() => webCtx.webServer.register(swaggerRoute), `agent-http: ${swaggerRoute.path} docs route`)
        }
      }
      if (this.config.console) {
        for (const consoleRoute of consoleRoutes()) {
          webCtx.effect(() => webCtx.webServer.register(consoleRoute), `agent-http: ${consoleRoute.path} console route`)
        }
      }
    })
  }

  /**
   * Authenticate one request and answer it through the shared gateway under
   * the resolved tenant's authority. Authentication, tenant resolution, and
   * membership fail closed before any method runs, with no exception for an
   * administrative token: tenant administration is served by
   * `@deepseek-ai/dsh-tenant-admin-http` at its own prefix.
   * @param request - the incoming Fetch request (unary RPC or SSE channel).
   * @returns the gateway's response, or a 401/403/500 fail-closed rejection.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      const principal = await this.ctx.tenantAuth.authenticate(request.headers.get('authorization') ?? '')
      const tenantId = principal.tenantId
      // The business surface serves one tenant's sessions: a platform credential
      // proves no tenant, so it is refused here and served by /admin instead.
      if (tenantId === undefined) {
        throw new TenantAuthError('INVALID_TOKEN', 'this surface requires a tenant-scoped credential')
      }
      const subject = UserId(principal.subject)
      const tenant = this.ctx.tenants.resolveMember(tenantId, subject)
      return await runWithScopes(principal.scopes, () =>
        runWithTenant(tenant, () => runWithUser(subject, () => this.delegate(request, tenant, subject))))
    } catch (error: unknown) {
      if (error instanceof TenantAuthError) {
        return jsonError(401, error.code, error.message, { 'www-authenticate': 'Bearer' })
      }
      if (error instanceof TenantError) {
        return jsonError(403, error.code, error.message)
      }
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(error instanceof Error ? error : new Error(message))
      return jsonError(500, 'INTERNAL', message)
    }
  }

  /** Run the gateway for one resolved (tenant, user), scoping the cross-session channels it answers. */
  private async delegate(request: Request, tenant: Tenant, user: UserId): Promise<Response> {
    const { pathname } = new URL(request.url)
    const channelMethod = pathname.startsWith(`${API_PATH}/`) ? pathname.slice(API_PATH.length + 1) : ''
    const operation = request.method === 'POST' ? TENANT_QUESTION_METHODS.get(channelMethod) : undefined
    // The question channel's own methods answer here, in place of the gateway's
    // closed method map; every other request — including a non-POST on these
    // paths — is the gateway's to answer.
    if (operation !== undefined) return await this.answerQuestionMethod(request, channelMethod, operation)
    if (request.method === 'POST' && SESSION_ADDRESSED_METHODS.has(channelMethod)) {
      const addressed = await addressedSession(request)
      if (addressed !== undefined && !await this.recorded(addressed.sessionId, tenant.id, user)) {
        return sessionNotFound(addressed.rpcId, addressed.sessionId)
      }
    }
    const response = await toFetchHandler(this.ctx.apiProxy).fetch(request)
    const scopesStream = pathname === '/api/events.mux' || pathname === '/api/events.host'
    if (request.method === 'GET' && scopesStream && response.body !== null) {
      return new Response(
        scopedSseBody(response.body, sessionId => this.owns(sessionId, tenant.id, user)),
        { status: response.status, headers: response.headers },
      )
    }
    if (request.method === 'POST' && (pathname === '/api/session.list' || pathname === '/api/session.search')) {
      return await this.scopeSessionChannel(response, tenant.id, user)
    }
    return response
  }

  /**
   * Answer one of the question channel's methods.
   *
   * The two-level parse is the gateway's, so a business client sees one protocol:
   * the envelope first (a mismatch or an unreadable envelope is a 200
   * `bad-request` ServerResponse), then the payload, whose validation lives in
   * `ctx.tenantQuestions` (its `ZodError` becomes the same `bad-request`). The
   * carrier layer keeps the gateway's statuses too: 415 for a non-JSON media
   * type, 400 for a body that is not JSON, 500 for a crash in the channel, and 503
   * when no question channel is mounted.
   * @param request - the incoming request, already authenticated and scoped.
   * @param method - the channel method named by the path.
   * @param operation - the channel call this method makes.
   * @returns the ServerResponse full form, or a carrier-layer rejection.
   */
  private async answerQuestionMethod(
    request: Request,
    method: string,
    operation: TenantQuestionMethod,
  ): Promise<Response> {
    const questions = this.ctx.get('tenantQuestions')
    if (questions === undefined) return new Response(`question channel is not mounted: ${method}`, { status: 503 })
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const envelope = clientRequestSchema.safeParse(body)
    if (!envelope.success) {
      // Best effort at correlation, as the gateway does: a salvageable string
      // rpcId is echoed, otherwise the fixed sentinel keeps the response a valid
      // ServerResponse.
      const rawId = (body as { rpcId?: unknown } | null)?.rpcId
      const rpcId = typeof rawId === 'string' ? RpcId(rawId) : RpcId(INVALID_REQUEST_RPC_ID)
      return badRequest(rpcId, 'invalid client-request message', envelope.error.issues)
    }
    const message = envelope.data
    if (message.method !== method) {
      return badRequest(message.rpcId, `method "${message.method}" does not match path "${method}"`, [])
    }
    try {
      const value = await operation(questions, message.payload)
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } })
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        return badRequest(message.rpcId, `invalid payload for ${method}`, error.issues)
      }
      // Anything else is a failure the channel could not express as a payload
      // rejection — a resolution the session log refused, for instance — and the
      // carrier reports it as its own crash rather than as a 200 the business
      // client would read as an answer.
      return new Response(`handler failure: ${String(error)}`, { status: 500 })
    }
  }

  /** True when this (tenant, user) may see a session: cold (no live owner) or owned by it. */
  private owns(sessionId: unknown, tenantId: TenantId, user: UserId): boolean {
    if (typeof sessionId !== 'string') return false
    const owner = this.sessionScopes.get(sessionId)
    return owner === undefined || (owner.tenant === String(tenantId) && owner.user === user)
  }

  /**
   * True when the ambient (tenant, user) owns a session id. A live owner this
   * process observed decides on its own — claimed by this subject is admitted,
   * claimed by another is refused; an unclaimed id must be in the durable store,
   * which resolves the ambient tenant and user itself, so another tenant's
   * session is simply absent. An unclaimed id with no store to vouch for it is
   * refused rather than admitted.
   * @param sessionId - the id the request names.
   * @param tenantId - the authenticated tenant.
   * @param user - the authenticated subject.
   * @returns whether the request may address that session.
   */
  private async recorded(sessionId: string, tenantId: TenantId, user: UserId): Promise<boolean> {
    const owner = this.sessionScopes.get(sessionId)
    if (owner !== undefined) return owner.tenant === String(tenantId) && owner.user === user
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return false
    const headers = await persistence.list()
    return headers.some(header => String(header.id) === sessionId)
  }

  /**
   * Drop `session.list`/`session.search` items the ambient (tenant, user) does
   * not own, and items of sessions this tenant archived: an archived session
   * keeps its registry place for a later unarchive, but a listing that still
   * showed it would offer a session the tenant already put away.
   */
  private async scopeSessionChannel(response: Response, tenantId: TenantId, user: UserId): Promise<Response> {
    // Read the archive set before consuming the body: the snapshot has to come
    // from the ambient partition while this call still holds it.
    const archived = new Set<string>(
      (this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? []).map(String),
    )
    const body = await response.json() as {
      result?: { ok?: boolean; value?: { items?: Array<{ sessionId?: unknown }> } }
    }
    const result = body.result
    if (result?.ok !== true || result.value === undefined || result.value.items === undefined) {
      return reconstruct(response, body)
    }
    const items = result.value.items.filter(item =>
      this.owns(item.sessionId, tenantId, user) && !archived.has(String(item.sessionId)))
    return reconstruct(response, { ...body, result: { ...result, value: { ...result.value, items } } })
  }
}

/**
 * Rebuild a consumed JSON response so the carrier can alter or pass through a
 * body it already read. Stale entity headers are dropped; bytes are re-encoded.
 * @param original - the response whose status and headers carry over.
 * @param body - the replacement JSON value.
 * @returns a fresh response with an unread body.
 */
function reconstruct(original: Response, body: unknown): Response {
  const headers = new Headers(original.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('transfer-encoding')
  return new Response(JSON.stringify(body), { status: original.status, headers })
}

/**
 * Read the `rpcId` and `sessionId` a session-addressed request names.
 * @param request - the incoming client request, read through a clone so the gateway still receives it.
 * @returns the pair, or `undefined` when the body is not a readable client request.
 */
async function addressedSession(request: Request): Promise<{ rpcId: string; sessionId: string } | undefined> {
  try {
    const body = await request.clone().json() as { rpcId?: unknown; payload?: { sessionId?: unknown } }
    const sessionId = body.payload?.sessionId
    if (typeof body.rpcId !== 'string' || typeof sessionId !== 'string') return undefined
    return { rpcId: body.rpcId, sessionId }
  } catch {
    // A body that is not JSON, or one this carrier cannot read twice: the
    // gateway's own schema rejection owns that request.
    return undefined
  }
}

/**
 * Answer a session-addressed request whose id the ambient (tenant, user) has no
 * record of, in the gateway's own `session-not-found` form.
 * @param rpcId - the request's correlation id.
 * @param sessionId - the id the request named.
 * @returns the JSON-RPC error response.
 */
function sessionNotFound(rpcId: string, sessionId: string): Response {
  return Response.json({
    type: 'server-response',
    rpcId: RpcId(rpcId),
    result: {
      ok: false,
      error: {
        code: 'session-not-found',
        message: `session '${sessionId}' was not found`,
        details: { sessionId },
      },
    },
  })
}

/**
 * Scope one parsed SSE frame to the ambient tenant. Session-scoped frames
 * (`sessionId`, covering the mux stream and the host stream's
 * session-added/removed/status/agent-error frames) are dropped when their
 * session belongs to another tenant; the host stream's
 * `host/archived-sessions-changed` frame keeps only owned/cold ids in its
 * `archivedSessionIds` snapshot. Frames without a session key — workspace
 * snapshots, the host `remote-event` passthrough, `stream/error` — pass
 * through unchanged.
 * @param frame - the parsed SSE `data:` object.
 * @param owns - whether one session id is visible to the ambient tenant.
 * @returns the frame, a scoped replacement, or null to drop it.
 */
function scopedFrame(frame: unknown, owns: (sessionId: unknown) => boolean): unknown {
  if (typeof frame !== 'object' || frame === null || !('payload' in frame)) return frame
  const payload: unknown = frame.payload
  if (typeof payload !== 'object' || payload === null) return frame
  if ('sessionId' in payload) return owns(payload.sessionId) ? frame : null
  if ('archivedSessionIds' in payload && Array.isArray(payload.archivedSessionIds)) {
    const archived = payload.archivedSessionIds
    const kept = archived.filter(owns)
    if (kept.length === archived.length) return frame
    return { ...frame, payload: { ...payload, archivedSessionIds: kept } }
  }
  return frame
}

/** An SSE unit the carrier may keep whole, drop, or rewrite. */
function filteredSseUnit(unit: string, owns: (sessionId: unknown) => boolean): string | null {
  if (!unit.startsWith('data: ')) return unit
  try {
    const frame = JSON.parse(unit.slice('data: '.length)) as unknown
    const scoped = scopedFrame(frame, owns)
    if (scoped === null) return null
    if (scoped === frame) return unit
    return `data: ${JSON.stringify(scoped)}\n\n`
  } catch {
    // The gateway only emits JSON frames; an unparseable one is dropped fail-closed.
    return null
  }
}

/** Re-emit an SSE byte stream with cross-tenant session frames dropped. */
function scopedSseBody(body: ReadableStream<Uint8Array>, owns: (sessionId: unknown) => boolean): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = body.getReader()
      void (async () => {
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            buffer += decoder.decode(next.value, { stream: true })
            let boundary: number
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const unit = buffer.slice(0, boundary + 2)
              buffer = buffer.slice(boundary + 2)
              const kept = filteredSseUnit(unit, owns)
              if (kept !== null) controller.enqueue(encoder.encode(kept))
            }
          }
          buffer += decoder.decode()
          if (buffer.length > 0) controller.enqueue(encoder.encode(buffer))
          controller.close()
        } catch (error: unknown) {
          controller.error(error)
        }
      })()
    },
    cancel(reason) {
      void body.cancel(reason)
    },
  })
}

function jsonError(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Sentinelled rpcId the gateway uses for an envelope whose own id is unreadable. */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

/**
 * Report a rejected request in the 200 ServerResponse body both surfaces use for
 * business errors, so a business client cannot tell which side answered.
 * @param rpcId - the request's rpcId, or the sentinel when it was unreadable.
 * @param message - why the request was rejected.
 * @param issues - the field-level detail of the rejection.
 * @returns the response carrying the error.
 */
function badRequest(rpcId: RpcId, message: string, issues: unknown[]): Response {
  return Response.json({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: 'bad-request', message, details: { issues } } },
  })
}

export default AgentHttp
