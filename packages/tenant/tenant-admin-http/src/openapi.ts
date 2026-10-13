/**
 * OpenAPI 3.1 description of the management surface: one `POST <prefix>/<method>`
 * path per management method, with each method's payload and value schemas
 * projected to JSON Schema through zod's `z.toJSONSchema`. The carrier serves
 * this document as the wire reference a platform integrating tenant
 * administration reads.
 * @module @deepseek-ai/dsh-tenant-admin-http/openapi
 */

import { z } from 'zod'
import { OPERATIONS } from './operations.ts'

/** OpenAPI 3.1 document (the subset this generator emits). */
export interface AdminOpenApiDocument {
  openapi: '3.1.0'
  info: { title: string; version: string; description: string }
  paths: Record<string, unknown>
  components: Record<string, unknown>
}

/** The failure body every method answers with, without the per-code detail branches. */
const FAILURE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'error'],
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
}

/**
 * Project a zod schema to a JSON Schema fragment. A schema zod cannot
 * represent degrades to the permissive empty schema rather than failing the
 * whole document.
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

/** The success-or-failure response body of one method. */
function responseEnvelope(valueRef: string): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'value'],
        properties: { ok: { const: true }, value: { $ref: valueRef } },
      },
      { $ref: '#/components/schemas/AdminError' },
    ],
  }
}

/**
 * Generate the management surface's OpenAPI document.
 * @param basePath - the prefix the surface is served under, e.g. `/admin`.
 * @returns the document: one `POST <basePath>/<method>` path per method, with
 *   each method's payload and value schemas under `components.schemas`.
 */
export function adminOpenApiDocument(basePath: string): AdminOpenApiDocument {
  const schemas: Record<string, unknown> = { AdminError: FAILURE_SCHEMA }
  const paths: Record<string, unknown> = {}

  for (const [method, operation] of Object.entries(OPERATIONS)) {
    const key = method.replaceAll('.', '_')
    const payloadName = `${key}Payload`
    const valueName = `${key}Value`
    schemas[payloadName] = jsonSchema(operation.schema)
    schemas[valueName] = jsonSchema(operation.value)
    paths[`${basePath}/${method}`] = {
      post: {
        operationId: method,
        tags: [method.split('.')[0]],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${payloadName}` } } },
        },
        responses: {
          200: {
            description: `Outcome for ${method}`,
            content: { 'application/json': { schema: responseEnvelope(`#/components/schemas/${valueName}`) } },
          },
          400: { description: 'Unreadable body or invalid payload (bad-request, tenant-invalid)' },
          401: { description: 'Missing or invalid bearer token' },
          403: { description: 'Token lacks the administrative scope (tenant-forbidden)' },
          404: { description: 'Unknown tenant or unknown management method' },
          409: { description: 'A tenant with this id already exists (tenant-conflict)' },
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'DeepSeek Harness tenant administration API',
      version: '0',
      description: `Tenant-management surface over POST ${basePath}/<method>. Authenticate with a bearer JWT carrying the administrative scope; no tenant membership is involved.`,
    },
    paths,
    components: {
      schemas,
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
  }
}
