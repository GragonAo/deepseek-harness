/**
 * mcp domain zod schemas (names derived from map keys: mcpSystemServersRequestSchema /
 * mcpSystemServersValueSchema / …).
 *
 * The server-name pattern and the URL rules mirror the registry's own guards, so a
 * malformed row fails as `bad-request` here instead of travelling to the medium.
 * The registry re-checks everything on write — this layer only spares the round
 * trip, it is not the authority.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { McpEffectiveServerView, McpProbeView, McpServerConcurrencyView, McpServerView } from './mcp.ts'

/** Server namespace: what `mcp__<name>__<tool>` is built from. */
export const mcpServerNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)

/** Streamable HTTP endpoint. `stdio` is not representable in this registry. */
export const mcpServerUrlSchema = z.string().min(1).regex(/^https?:\/\//, 'endpoint must be an http(s) URL')

/** Per-server concurrency policy. */
export const mcpServerConcurrencyViewSchema = z.object({
  policy: z.enum(['annotations', 'parallel', 'exclusive']).optional(),
  maxConcurrentCalls: z.number().int().min(1).optional(),
  exclusiveTools: z.array(z.string()).optional(),
}) satisfies z.ZodType<Wire<McpServerConcurrencyView>>

/** One stored server as a surface reads it. */
export const mcpServerViewSchema = z.object({
  serverName: mcpServerNameSchema,
  url: z.string(),
  headerNames: z.array(z.string()),
  hasAuthorization: z.boolean(),
  timeoutMs: z.number().optional(),
  toolConcurrency: mcpServerConcurrencyViewSchema.optional(),
  enabled: z.boolean(),
  descr: z.string().optional(),
  updatedAt: z.string(),
  origin: z.enum(['system', 'user']),
  mountName: z.string(),
}) satisfies z.ZodType<Wire<McpServerView>>

/** One row of the merged effective set. */
export const mcpEffectiveServerViewSchema = mcpServerViewSchema.extend({
  origin: z.enum(['system', 'user']),
  mounted: z.boolean(),
}) satisfies z.ZodType<Wire<McpEffectiveServerView>>

/** mcp.systemServers / mcp.saveServer / mcp.removeServer response value. */
export const mcpRegistrySnapshotValueSchema = z.object({
  servers: z.array(mcpServerViewSchema),
  revision: z.number(),
}) satisfies z.ZodType<Wire<ResponseValue<'mcp.systemServers'>>>

/** mcp.myServers response value. */
export const mcpMyServersValueSchema = z.object({
  servers: z.array(mcpServerViewSchema),
  system: z.array(mcpServerViewSchema),
  revision: z.number(),
}) satisfies z.ZodType<Wire<ResponseValue<'mcp.myServers'>>>

/** Every mcp method that takes no payload. */
export const mcpEmptyRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'mcp.systemServers'>>>

/** mcp.saveServer / mcp.saveMyServer request payload. */
export const mcpSaveServerRequestSchema = z.object({
  serverName: mcpServerNameSchema,
  url: mcpServerUrlSchema,
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1).optional(),
  toolConcurrency: z.object({
    policy: z.enum(['annotations', 'parallel', 'exclusive']).optional(),
    maxConcurrentCalls: z.number().int().min(1).optional(),
    exclusiveTools: z.array(z.string()).optional(),
  }).optional(),
  enabled: z.boolean().optional(),
  descr: z.string().max(500).optional(),
  expectedRevision: z.number().int().min(0).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'mcp.saveServer'>>>

/** mcp.removeServer / mcp.removeMyServer request payload. */
export const mcpRemoveServerRequestSchema = z.object({
  serverName: mcpServerNameSchema,
  expectedRevision: z.number().int().min(0).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'mcp.removeServer'>>>

/** mcp.effectiveServers response value. */
export const mcpEffectiveServersValueSchema = z.object({
  servers: z.array(mcpEffectiveServerViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'mcp.effectiveServers'>>>

/** mcp.testConnection request payload: a form draft, or a saved row by name. */
export const mcpTestConnectionRequestSchema = z.object({
  serverName: mcpServerNameSchema.optional(),
  url: mcpServerUrlSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1).max(60_000).optional(),
}).refine(payload => payload.serverName !== undefined || payload.url !== undefined, {
  message: 'a connectivity test needs a url, or the serverName of a saved row',
}) satisfies z.ZodType<Wire<RequestPayload<'mcp.testConnection'>>>

/** What a live probe answers. */
export const mcpProbeViewSchema = z.object({
  ok: z.boolean(),
  toolsSupported: z.boolean(),
  toolCount: z.number().optional(),
  latencyMs: z.number(),
  error: z.string().optional(),
  addressAllowed: z.boolean(),
}) satisfies z.ZodType<Wire<McpProbeView>>

/** mcp.testConnection response value. */
export const mcpProbeValueSchema = mcpProbeViewSchema satisfies z.ZodType<Wire<ResponseValue<'mcp.testConnection'>>>
