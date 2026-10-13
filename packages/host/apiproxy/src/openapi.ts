/**
 * OpenAPI 3.1 description of the unary RPC surface: one `POST /api/<method>`
 * path per `RpcMethodMap` key, with each method's zod request/value schema
 * projected to JSON Schema through zod's built-in `z.toJSONSchema`. A carrier
 * that owns a `webServer` (the multi-tenant `agent-http`) serves this document
 * behind a Swagger UI so integrators can browse and try the surface.
 *
 * The wire is the four-quadrant RPC envelope: a request body is a
 * `client-request` with `method` pinned and `payload` narrowed per route; a
 * response is a `server-response` whose `result` is `{ ok: true, value }` on
 * success or `{ ok: false, error }` on a business failure.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/openapi
 */

import { z } from 'zod'
import { UNARY_ROUTES } from './fetch/handler.ts'
import { UNARY_VALUE_SCHEMAS } from './fetch/client.ts'
import type { RpcMethodMap } from './api/rpc-map.ts'

/** OpenAPI 3.1 document (the subset this generator emits). */
export interface OpenApiDocument {
  openapi: '3.1.0'
  info: { title: string; version: string; description?: string }
  paths: Record<string, unknown>
  components: Record<string, unknown>
}

const METHOD_KEYS = Object.keys(UNARY_ROUTES) as Array<keyof RpcMethodMap>

/** Shared business-error body: code/message/details without the wire's per-code detail branches. */
const RPC_ERROR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['code', 'message', 'details'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
}

/** Method name → component-schema key (dots become underscores for a valid `$ref` fragment). */
function schemaKey(method: string): string {
  return method.replaceAll('.', '_')
}

/**
 * Project a zod schema to a JSON Schema fragment. A schema zod cannot represent
 * (e.g. a `z.custom`) degrades to the permissive empty schema rather than
 * failing the whole document.
 * @param schema - the zod schema.
 * @returns the JSON Schema body, without the top-level `$schema` dialect marker.
 */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const projected = { ...(z.toJSONSchema(schema) as Record<string, unknown>) }
    delete projected.$schema
    return projected
  } catch {
    return {}
  }
}

/** The `client-request` envelope with `method` pinned and `payload` narrowed per route. */
function requestEnvelope(method: string, payloadRef: string): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'rpcId', 'method', 'payload'],
    properties: {
      type: { const: 'client-request' },
      rpcId: { type: 'string' },
      method: { const: method },
      payload: { $ref: payloadRef },
    },
  }
}

/** The `server-response` envelope: `{ ok: true, value }` or `{ ok: false, error }`. */
function responseEnvelope(valueRef: string): Record<string, unknown> {
  return {
    type: 'object',
    required: ['type', 'rpcId', 'result'],
    properties: {
      type: { const: 'server-response' },
      rpcId: { type: 'string' },
      result: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'value'],
            properties: { ok: { const: true }, value: { $ref: valueRef } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'error'],
            properties: { ok: { const: false }, error: { $ref: '#/components/schemas/RpcError' } },
          },
        ],
      },
    },
  }
}

/**
 * Generate the OpenAPI 3.1 document describing every unary RPC route.
 * @returns the document: one `POST /api/<method>` path per route; each method's
 *   request payload and response value live under `components.schemas`.
 */
export function generateOpenApiDocument(): OpenApiDocument {
  const schemas: Record<string, unknown> = { RpcError: RPC_ERROR_SCHEMA }
  const paths: Record<string, unknown> = {}

  for (const method of METHOD_KEYS) {
    const key = schemaKey(method)
    const payloadName = `${key}RequestPayload`
    const valueName = `${key}ResponseValue`
    schemas[payloadName] = jsonSchema(UNARY_ROUTES[method].schema)
    schemas[valueName] = jsonSchema(UNARY_VALUE_SCHEMAS[method])
    paths[`/api/${method}`] = {
      post: {
        operationId: method,
        tags: [method.split('.')[0]],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: requestEnvelope(method, `#/components/schemas/${payloadName}`),
            },
          },
        },
        responses: {
          200: {
            description: `Outcome for ${method}`,
            content: {
              'application/json': {
                schema: responseEnvelope(`#/components/schemas/${valueName}`),
              },
            },
          },
          400: { description: 'Unreadable envelope or invalid payload (bad-request)' },
          401: { description: 'Missing or invalid bearer token' },
          403: { description: 'Token lacks the required scope or tenant membership' },
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'DeepSeek Harness RPC API',
      version: '0',
      description: 'Unary JSON-RPC surface over POST /api/<method>. Authenticate with a bearer JWT proving one tenant and one subject; tenant administration is served separately by the tenant-management carrier.',
    },
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  }
}
