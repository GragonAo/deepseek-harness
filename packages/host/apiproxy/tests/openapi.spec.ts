/**
 * The OpenAPI document projects the unary RPC surface: one POST path per
 * `RpcMethodMap` key, with each route's zod payload/value schema rendered as
 * JSON Schema and wrapped in the four-quadrant client-request / server-response
 * envelope. These tests pin the carrier-facing facts integrators rely on: the
 * route set, the method-pinned request body, and the ok/value + ok/error split.
 */

import { describe, expect, it } from 'vitest'
import { generateOpenApiDocument } from '@deepseek-ai/dsh-host-apiproxy'

type Json = Record<string, unknown>

function path(method: string): Json {
  const doc = generateOpenApiDocument()
  const routes = doc.paths[`/api/${method}`]
  if (routes === undefined) throw new Error(`no /api/${method} path`)
  return (routes as Json).post as Json
}

describe('generateOpenApiDocument', () => {
  const doc = generateOpenApiDocument()
  const schemas = doc.components.schemas as Json

  it('declares one POST path per unary RPC route with bearer security', () => {
    expect(doc.openapi).toBe('3.1.0')
    const routes = Object.keys(doc.paths)
    // session.* + subagent.* + host.* + workspace.* + skill.list + agentPreset.* +
    // goal.* + settings.* + credentials.* + llm.* = 52 routes.
    expect(routes).toHaveLength(52)
    for (const route of routes) {
      const operation = (doc.paths[route] as Json).post as Json
      expect(operation.security).toEqual([{ bearerAuth: [] }])
    }
    const security = (doc.components.securitySchemes as Json).bearerAuth
    expect(security).toEqual({ type: 'http', scheme: 'bearer' })
  })

  it('pins the method and narrows payload in the request envelope', () => {
    const body = (path('credentials.set').requestBody as Json).content as Json
    const schema = (body['application/json'] as Json).schema as Json
    expect(schema.required).toEqual(['type', 'rpcId', 'method', 'payload'])
    expect((schema.properties as Json).type).toEqual({ const: 'client-request' })
    expect((schema.properties as Json).method).toEqual({ const: 'credentials.set' })
    expect((schema.properties as Json).payload).toEqual({ $ref: '#/components/schemas/credentials_setRequestPayload' })
  })

  it('projects the credentials.set payload schema', () => {
    const payload = schemas.credentials_setRequestPayload as Json
    expect(payload.required).toEqual(['ref', 'value'])
    expect(payload.properties).toHaveProperty('ref')
  })

  it('splits the response result into ok/value and ok/error', () => {
    const body = (path('credentials.describe').responses as Record<string, unknown>)['200'] as Json
    const schema = ((body.content as Json)['application/json'] as Json).schema as Json
    const result = (schema.properties as Json).result as Json
    expect(result.oneOf).toHaveLength(2)
  })
})
