import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { TenantId, TenantRegistry, requireTenant } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantAuthError } from '@deepseek-ai/dsh-tenant-auth'
import type { TenantPrincipal } from '@deepseek-ai/dsh-tenant-auth'
import { TenantHttpApi } from '../src/index.ts'

function tenant(id: string, enabled = true): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/workspace/${id}`,
    enabled,
  }
}

/** Minimal request/response doubles for the stateless route handler. */
interface FakeRes {
  statusCode: number
  headers: Record<string, string | number>
  body: string
  writeHead(status: number, headers?: Record<string, string | number>): void
  end(chunk: string): void
}

function fakeRes(): FakeRes {
  const res = { statusCode: 0, headers: {}, body: '' } as FakeRes
  res.writeHead = (status, headers) => {
    res.statusCode = status
    Object.assign(res.headers, headers)
  }
  res.end = (chunk) => { res.body = chunk ?? '' }
  return res
}

/** The handler reads only `writeHead`/`end`; cast the double at the boundary. */
function asResponse(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse
}

function fakeReq(method = 'POST', authorization?: string, bodyText = ''): IncomingMessage {
  const request = {
    method,
    headers: authorization === undefined ? {} : { authorization },
    [Symbol.asyncIterator]() {
      let done = false
      return {
        next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: Buffer.from(bodyText) })),
      }
    },
  }
  return request as unknown as IncomingMessage
}

function setup() {
  const ctx = new Context()
  const registry = new TenantRegistry(ctx)
  registry.register(tenant('acme'))
  registry.register(tenant('globex', false))
  let route: WebRoute | undefined
  const webServer = {
    register: (r: WebRoute) => { route = r; return () => { route = undefined } },
  }
  const tenantAuth = {
    authenticate: async (credential: string): Promise<TenantPrincipal> => {
      if (credential === '') throw new TenantAuthError('MISSING_CREDENTIAL', 'no credential')
      const token = credential.replace(/^Bearer /, '')
      if (token === 'bad') throw new TenantAuthError('INVALID_TOKEN', 'unverifiable')
      return { tenantId: tenant(token).id, subject: 'user-1' }
    },
  }
  ctx.provide('webServer', webServer)
  ctx.provide('tenantAuth', tenantAuth)
  return { api: new TenantHttpApi(ctx, { path: '/v1/run' }), routeIs: () => route }
}

function errorCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code
}

describe('TenantHttpApi', () => {
  it('rejects a missing credential with 401', async () => {
    const { api, routeIs } = setup()
    api.register(async () => ({ ok: true }))
    const res = fakeRes()
    await routeIs()!.handler(fakeReq('POST', undefined), asResponse(res))
    expect(res.statusCode).toBe(401)
    expect(errorCode(res.body)).toBe('MISSING_CREDENTIAL')
  })

  it('rejects an unverifiable token with 401', async () => {
    const { api, routeIs } = setup()
    api.register(async () => ({ ok: true }))
    const res = fakeRes()
    await routeIs()!.handler(fakeReq('POST', 'Bearer bad'), asResponse(res))
    expect(res.statusCode).toBe(401)
    expect(errorCode(res.body)).toBe('INVALID_TOKEN')
  })

  it('rejects an unknown tenant with 403', async () => {
    const { api, routeIs } = setup()
    api.register(async () => ({ ok: true }))
    const res = fakeRes()
    await routeIs()!.handler(fakeReq('POST', 'Bearer unknown'), asResponse(res))
    expect(res.statusCode).toBe(403)
    expect(errorCode(res.body)).toBe('TENANT_UNKNOWN')
  })

  it('rejects a disabled tenant with 403', async () => {
    const { api, routeIs } = setup()
    api.register(async () => ({ ok: true }))
    const res = fakeRes()
    await routeIs()!.handler(fakeReq('POST', 'Bearer globex'), asResponse(res))
    expect(res.statusCode).toBe(403)
    expect(errorCode(res.body)).toBe('TENANT_DISABLED')
  })

  it('scopes the tenant and runs the operation with a parsed body', async () => {
    const { api, routeIs } = setup()
    api.register(async ({ tenant: active, body }) => ({ seen: requireTenant().id, name: active.name, body }))
    const res = fakeRes()
    await routeIs()!.handler(fakeReq('POST', 'Bearer acme', '{"x":1}'), asResponse(res))
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body) as { ok: boolean; tenantId: string; result: unknown }
    expect(parsed.ok).toBe(true)
    expect(parsed.tenantId).toBe('acme')
    expect(parsed.result).toEqual({ seen: 'acme', name: 'acme', body: { x: 1 } })
  })

  it('answers non-POST methods with 405', async () => {
    const { api, routeIs } = setup()
    api.register(async () => ({ ok: true }))
    const res = fakeRes()
    await routeIs()!.handler(fakeReq('GET'), asResponse(res))
    expect(res.statusCode).toBe(405)
  })

  it('refuses a second operation registration', () => {
    const { api } = setup()
    api.register(async () => ({ ok: true }))
    expect(() => api.register(async () => ({ ok: false }))).toThrow(/already registered/)
  })
})
