/**
 * Tenant-administration HTTP carrier (`ctx.tenantAdminHttp`): the management
 * face of the tenant registry, served under its own `/admin` prefix and gated
 * by the administrative OIDC scope alone. It resolves no tenant and checks no
 * membership, so a platform operator's token needs no tenant of its own, and
 * every method runs inside `runWithScopes` — the ambient scopes
 * `ctx.tenantAdmin` re-checks before it touches a record.
 *
 * The business surface (`ctx.agentHttp` at `/api`) serves the opposite
 * authority: a tenant and a subject the credential itself proves. Keeping the
 * two surfaces apart is what lets an administrative token stay platform-scoped
 * instead of having to be a member of some tenant to be admitted.
 *
 * `/admin` is a protocol constant rather than configuration: the wire
 * reference, the operator console, and this carrier's README name the same
 * literal.
 * @module @deepseek-ai/dsh-tenant-admin-http
 */

import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { DEFAULT_TENANT_ADMIN_SCOPE, requireScope, runWithScopes, TenantError } from '@deepseek-ai/dsh-tenant'
import { TenantAdminError } from '@deepseek-ai/dsh-tenant-admin'
import { TenantAuthError } from '@deepseek-ai/dsh-tenant-auth'
import { SkillInstallError, type SkillInstallErrorCode } from '@deepseek-ai/dsh-skill-install'
import { ZodError } from 'zod'
import { AdminRequestError } from './errors.ts'
import { OPERATIONS } from './operations.ts'
import { adminOpenApiDocument } from './openapi.ts'
import type { AdminErrorBody } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenantAdminHttp: TenantAdminHttp
  }
}

/** Prefix the management surface is served under. */
export const ADMIN_PATH = '/admin'

/** Path of the management surface's own wire reference. */
export const ADMIN_OPENAPI_PATH = `${ADMIN_PATH}/openapi.json`

/**
 * Default cap on a management request body. Every payload names a tenant, a
 * subject, or a host path; none carries content, so the default is far below
 * the business surface's aggregate-image budget.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024

/**
 * Default cap on a `skills.upload` body. That payload carries a zip archive as
 * base64, which is one third larger than the archive itself, so the cap is set
 * above the largest bundle `@deepseek-ai/dsh-skill-install` accepts by default.
 */
const DEFAULT_MAX_UPLOAD_BODY_BYTES = 32 * 1024 * 1024

/** Status each bundle failure answers with; the code itself is the carrier's own. */
const SKILL_ERROR_STATUS: Record<SkillInstallErrorCode, number> = {
  'tier-unavailable': 503,
  'bundle-invalid': 400,
  'bundle-unsafe-entry': 400,
  'bundle-too-large': 413,
  'skill-invalid': 400,
  'skill-exists': 409,
  'skill-absent': 404,
  'skill-ambiguous': 409,
}

/** Plugin configuration. */
export interface Config {
  /** OIDC scope admitting the management surface. */
  adminScope?: string
  /** Maximum buffered request-body bytes before the carrier answers 413. */
  maxRequestBodyBytes?: number
  /** Maximum buffered `skills.upload` request-body bytes, which carry a base64 zip. */
  maxUploadBodyBytes?: number
  /** Serve `GET /admin/openapi.json` (the management wire reference). */
  openapi?: boolean
}

interface ResolvedConfig {
  adminScope: string
  maxRequestBodyBytes: number
  maxUploadBodyBytes: number
  openapi: boolean
}

/** Write one JSON response, with `content-length` so the body is never chunked. */
function respond(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  })
  res.end(payload)
}

/** Write one failure body under the surface's single envelope. */
function fail(res: ServerResponse, status: number, error: AdminErrorBody, headers?: Record<string, string>): void {
  respond(res, status, { ok: false, error }, headers)
}

/**
 * The management method one request names: everything after the prefix, e.g.
 * `tenants.list` for `POST /admin/tenants.list`.
 * @param pathname - the request pathname.
 * @returns the method name the request addresses.
 */
function methodOf(pathname: string): string {
  return pathname.slice(ADMIN_PATH.length).replace(/^\/+/u, '').replace(/\/+$/u, '')
}

/**
 * Read one JSON request body, bounded by the configured cap.
 * @param req - the incoming request.
 * @param maxBytes - maximum buffered bytes.
 * @returns the parsed body; `{}` for an empty body.
 * @throws `AdminRequestError` code `request-too-large` or `bad-request`.
 */
async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBytes) {
    throw new AdminRequestError(413, 'request-too-large', `request body exceeds ${String(maxBytes)} bytes`)
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    // The connection closes rather than draining the rest: a body this surface
    // refuses must not be read to its end first.
    if (received > maxBytes) {
      throw new AdminRequestError(413, 'request-too-large', `request body exceeds ${String(maxBytes)} bytes`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AdminRequestError(400, 'bad-request', 'request body is not valid JSON')
  }
}

/**
 * Tenant-administration carrier. Load it beside `ctx.tenantAuth` and
 * `ctx.tenantAdmin`; it registers its `/admin` prefix route and, unless
 * disabled, its wire reference.
 */
export class TenantAdminHttp extends Service {
  static inject = ['webServer', 'tenantAuth', 'tenantAdmin']
  static Config: z<Config> = z.object({
    adminScope: z.string().default(DEFAULT_TENANT_ADMIN_SCOPE),
    maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
    maxUploadBodyBytes: z.natural().min(1).default(DEFAULT_MAX_UPLOAD_BODY_BYTES),
    openapi: z.boolean().default(true),
  })

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tenantAdminHttp')
    this.config = {
      adminScope: config.adminScope ?? DEFAULT_TENANT_ADMIN_SCOPE,
      maxRequestBodyBytes: config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
      maxUploadBodyBytes: config.maxUploadBodyBytes ?? DEFAULT_MAX_UPLOAD_BODY_BYTES,
      openapi: config.openapi ?? true,
    }
    ctx.effect(() => {
      const routes: WebRoute[] = [
        { kind: 'prefix', path: ADMIN_PATH, handler: (req, res) => this.handle(req, res) },
      ]
      if (this.config.openapi) {
        routes.push({
          kind: 'exact',
          path: ADMIN_OPENAPI_PATH,
          handler: (_req, res) => { respond(res, 200, adminOpenApiDocument(ADMIN_PATH)) },
        })
      }
      const unregister = routes.map(route => this.ctx.webServer.register(route))
      return () => {
        for (const remove of unregister) remove()
      }
    }, 'tenantAdminHttp: register the /admin routes')
  }

  /**
   * Serve one management request: authenticate, gate on the administrative
   * scope, validate the payload, and run the method against `ctx.tenantAdmin`.
   * @param req - the incoming request.
   * @param res - the response this handler owns.
   */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = methodOf(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
      const operation = OPERATIONS[method]
      if (operation === undefined) {
        throw new AdminRequestError(404, 'unknown-method', `no management method '${method}'`)
      }
      if (req.method !== 'POST') {
        fail(res, 405, { code: 'method-not-allowed', message: 'the management surface answers POST only' }, { allow: 'POST' })
        return
      }
      const principal = await this.ctx.tenantAuth.authenticate(req.headers.authorization ?? '')
      const body = await readJson(req, this.bodyLimit(method))
      const skillInstall = this.ctx.get('skillInstall')
      const value = await runWithScopes(principal.scopes, async () => {
        requireScope(this.config.adminScope)
        return await operation.invoke({ admin: this.ctx.tenantAdmin, skillInstall }, body)
      })
      respond(res, 200, { ok: true, value })
    } catch (error: unknown) {
      this.respondError(res, error)
    }
  }

  /**
   * Resolve the request-body cap for one method.
   * @param method - the method the request names.
   * @returns the byte cap the body is buffered under.
   */
  private bodyLimit(method: string): number {
    return method.startsWith('skills.') ? this.config.maxUploadBodyBytes : this.config.maxRequestBodyBytes
  }

  /** Map one failure onto the surface's status + code vocabulary. */
  private respondError(res: ServerResponse, error: unknown): void {
    if (error instanceof TenantAuthError) {
      fail(res, 401, { code: error.code, message: error.message }, { 'www-authenticate': 'Bearer' })
      return
    }
    if (error instanceof TenantError) {
      if (error.code === 'MISSING_SCOPE') {
        fail(res, 403, {
          code: 'tenant-forbidden',
          message: error.message,
          details: { scope: this.config.adminScope },
        })
        return
      }
      if (error.code === 'TENANT_UNKNOWN') {
        fail(res, 404, { code: 'tenant-not-found', message: error.message })
        return
      }
      if (error.code === 'DUPLICATE_TENANT') {
        fail(res, 409, { code: 'tenant-conflict', message: error.message })
        return
      }
      // A management method must never need an ambient tenant or subject: this
      // surface proves a scope, not a tenant, so such a failure is a defect in
      // the method and stays a 500 rather than being mapped to a client error.
      this.ctx.logger.warn(error)
      fail(res, 500, { code: 'internal', message: error.message })
      return
    }
    if (error instanceof TenantAdminError) {
      const invalid = error.code === 'invalid-input'
      fail(res, invalid ? 400 : 500, {
        code: invalid ? 'tenant-invalid' : 'tenant-provision-failed',
        message: error.message,
      })
      return
    }
    if (error instanceof SkillInstallError) {
      fail(res, SKILL_ERROR_STATUS[error.code], {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      })
      return
    }
    if (error instanceof ZodError) {
      fail(res, 400, {
        code: 'bad-request',
        message: 'request payload is invalid',
        details: { issues: error.issues },
      })
      return
    }
    if (error instanceof AdminRequestError) {
      const headers = error.status === 413 ? { connection: 'close' } : undefined
      fail(res, error.status, { code: error.code, message: error.message }, headers)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    this.ctx.logger.warn(error instanceof Error ? error : new Error(message))
    fail(res, 500, { code: 'internal', message })
  }
}

export default TenantAdminHttp
