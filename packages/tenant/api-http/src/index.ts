/**
 * Stateless tenant HTTP API (`ctx.tenantHttpApi`). One exact route
 * authenticates a bearer credential through `ctx.tenantAuth`, resolves the
 * tenant through `ctx.tenants`, enters `runWithTenant`, and hands request work
 * to a single registered operation. No agent or session state lives in this
 * process layer — the operation derives everything from the tenant scope and
 * the storage/container providers behind it.
 * @module @deepseek-ai/dsh-api-http
 */

import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { runWithTenant, TenantError } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantAuthError } from '@deepseek-ai/dsh-tenant-auth'
import type { TenantPrincipal } from '@deepseek-ai/dsh-tenant-auth'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenantHttpApi: TenantHttpApi
  }
}

/** The authenticated, tenant-scoped context handed to one operation. */
export interface TenantOperationInput {
  readonly tenant: Tenant
  readonly principal: TenantPrincipal
  readonly body: unknown
}

/** One request operation, always run inside the resolved tenant scope. */
export type TenantOperation<T = unknown> = (input: TenantOperationInput) => Promise<T>

/** Plugin configuration. */
export interface Config {
  /** Exact route pathname the operation serves. */
  path?: string
}

/** A request error with a fixed HTTP status and machine code. */
class HttpRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function respond(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw new HttpRequestError(400, 'BAD_REQUEST', 'request body is not valid JSON', { cause: error })
  }
}

/** Stateless tenant HTTP API registered as `ctx.tenantHttpApi`. */
export class TenantHttpApi extends Service {
  static inject = ['webServer', 'tenantAuth', 'tenants']
  static Config: z<Config> = z.object({
    path: z.string().default('/v1/run'),
  })

  private operation: TenantOperation | undefined

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'tenantHttpApi')
  }

  /**
   * Register the single request operation and its HTTP route.
   * @param operation - the tenant-scoped request operation.
   * @returns the disposer removing both the operation and its route.
   */
  register(operation: TenantOperation): () => void {
    if (this.operation !== undefined) {
      throw new Error('tenant-http: an operation is already registered')
    }
    this.operation = operation
    const route: WebRoute = {
      kind: 'exact',
      path: this.config.path ?? '/v1/run',
      handler: (req, res) => this.handle(req, res),
    }
    const unregister = this.ctx.webServer.register(route)
    return () => {
      unregister()
      this.operation = undefined
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') {
        respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
        return
      }
      const authorization = req.headers.authorization
      const principal = await this.ctx.tenantAuth.authenticate(authorization ?? '')
      const tenant = this.ctx.tenants.resolve(principal.tenantId)
      const body = await readJson(req)
      const operation = this.operation
      if (operation === undefined) throw new HttpRequestError(404, 'NOT_FOUND', 'no operation registered')
      const result = await runWithTenant(tenant, () => operation({ tenant, principal, body }))
      respond(res, 200, { ok: true, tenantId: String(tenant.id), result })
    } catch (error: unknown) {
      this.respondError(res, error)
    }
  }

  private respondError(res: ServerResponse, error: unknown): void {
    if (error instanceof TenantAuthError) {
      respond(res, 401, { error: { code: error.code, message: error.message } }, { 'www-authenticate': 'Bearer' })
      return
    }
    if (error instanceof TenantError) {
      respond(res, 403, { error: { code: error.code, message: error.message } })
      return
    }
    if (error instanceof HttpRequestError) {
      respond(res, error.status, { error: { code: error.code, message: error.message } })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    this.ctx.logger.warn(error instanceof Error ? error : new Error(message))
    respond(res, 500, { error: { code: 'INTERNAL', message } })
  }
}

export default TenantHttpApi
