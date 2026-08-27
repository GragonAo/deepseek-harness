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
 * also scopes the cross-session channels it exposes: `session.list` /
 * `session.search` items and the session-scoped frames on the `events.mux` /
 * `events.host` streams are filtered to the ambient (tenant, user)'s sessions.
 * Ownership comes from the `session/created` events observed under that
 * (tenant, user) authority — a session is visible to a subject when it has no
 * live owner in this process (a cold session the persistence layer already
 * bound to that subject) or its live owner is that same (tenant, user).
 *
 * When a `webServer` service is present, the carrier also registers the
 * `/api` prefix route (a fetch bridge replacing the single-user
 * `client-connection` trust fence), so `dsh web` can serve the multi-tenant
 * API over HTTP without any other carrier.
 *
 * @module @deepseek-ai/dsh-agent-http
 */

import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { currentTenant, currentUser, runWithTenant, runWithUser, TenantError, UserId } from '@deepseek-ai/dsh-tenant'
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

/** Carrier configuration. */
export interface Config {
  /** Maximum buffered request body bytes before the route answers 413. */
  maxRequestBodyBytes?: number
}

/** Multi-tenant carrier registered as `ctx.agentHttp`. */
export class AgentHttp extends Service {
  static inject = ['tenantAuth', 'tenants', 'apiProxy']
  static Config: z<Config> = z.object({
    maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
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
        handler: (req, res) => serveRequest(
          req, res, request => this.fetch(request),
          this.config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
        ),
      }
      webCtx.effect(() => webCtx.webServer.register(route), 'agent-http: /api carrier route')
    })
  }

  /**
   * Authenticate one request and answer it through the shared gateway under
   * the resolved tenant's authority. Authentication and tenant resolution fail
   * closed before any method runs.
   * @param request - the incoming Fetch request (unary RPC or SSE channel).
   * @returns the gateway's response, or a 401/403/500 fail-closed rejection.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      const principal = await this.ctx.tenantAuth.authenticate(request.headers.get('authorization') ?? '')
      const subject = UserId(principal.subject)
      const tenant = this.ctx.tenants.resolveMember(principal.tenantId, subject)
      return await runWithTenant(tenant, () => runWithUser(subject, () => this.delegate(request, tenant, subject)))
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

  /** True when this (tenant, user) may see a session: cold (no live owner) or owned by it. */
  private owns(sessionId: unknown, tenantId: TenantId, user: UserId): boolean {
    if (typeof sessionId !== 'string') return false
    const owner = this.sessionScopes.get(sessionId)
    return owner === undefined || (owner.tenant === String(tenantId) && owner.user === user)
  }

  /** Drop `session.list`/`session.search` items whose live owner is another (tenant, user). */
  private async scopeSessionChannel(response: Response, tenantId: TenantId, user: UserId): Promise<Response> {
    const body = await response.json() as {
      result?: { ok?: boolean; value?: { items?: Array<{ sessionId?: unknown }> } }
    }
    const result = body.result
    if (result?.ok !== true || result.value === undefined || result.value.items === undefined) {
      return reconstruct(response, body)
    }
    const items = result.value.items.filter(item => this.owns(item.sessionId, tenantId, user))
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
 * Bridge one node:http request to the carrier's fetch handler. The request
 * body is buffered (bounded by `maxRequestBodyBytes`); the response — including
 * SSE bodies — streams back with backpressure, and a client disconnect aborts
 * the handler's signal.
 * @param req - incoming node:http request (fully read before dispatch).
 * @param res - response the bridge writes and owns to completion.
 * @param handler - fetch-shaped carrier the request is dispatched to.
 * @param maxRequestBodyBytes - maximum bytes buffered before a 413.
 */
async function serveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
  maxRequestBodyBytes: number,
): Promise<void> {
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > maxRequestBodyBytes) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return
    }
    chunks.push(buffer)
  }
  const request = new Request(new URL(req.url ?? '/', 'http://dsh.internal'), {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][]),
    ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
    signal: abort.signal,
  })
  const response = await handler(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
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

export default AgentHttp
