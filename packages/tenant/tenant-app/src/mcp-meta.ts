/**
 * Per-call `_meta` for MCP tools, taken from the inbound request's headers.
 *
 * An MCP server that authorizes per caller needs the caller's identity on every
 * call, and the MCP protocol carries that in `params._meta` rather than in the
 * tool arguments the model writes. The headers that prove the caller arrive on
 * the request that starts the turn, and the tool calls happen later inside the
 * agent loop — still inside the same execution tree, which is why
 * `currentRequestHeaders()` answers there.
 *
 * The deployment names the mapping (`mcpMeta.fromHeaders`: `_meta` key →
 * request header). This plugin reads it and nothing else: which header carries
 * the user, the case, or a session is the deployment's fact, not this code's.
 *
 * @module @deepseek-ai/dsh-tenant-app/mcp-meta
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { currentRequestHeaders } from '@deepseek-ai/dsh-tenant'
import type { McpCallMeta } from '@deepseek-ai/dsh-mcp-client'
import type { McpMetaConfig } from './types.ts'

/**
 * MCP call metadata provided from the ambient inbound request headers
 * (`ctx.mcpCallMeta`).
 */
export class TenantMcpCallMeta extends Service implements McpCallMeta {
  /** `_meta` key → request header name, resolved once at load. */
  private readonly fromHeaders: Readonly<Record<string, string>>

  /**
   * @param ctx - the context to register `mcpCallMeta` in.
   * @param config - the deployment's `_meta` key → header name mapping.
   */
  constructor(ctx: Context, config: McpMetaConfig) {
    super(ctx, 'mcpCallMeta')
    this.fromHeaders = config.fromHeaders ?? {}
  }

  /**
   * Entries for the next `tools/call`.
   *
   * A header the request did not carry is omitted rather than sent empty: an
   * MCP server that authorizes per caller distinguishes "this caller named no
   * case" from "this caller's case is the empty string".
   * @returns the entries the mapping resolves to, or `undefined` when this call
   * has no ambient request or no mapped header was present.
   */
  entries(): Record<string, string> | undefined {
    const headers = currentRequestHeaders()
    if (headers === undefined) return undefined
    const entries: Record<string, string> = {}
    for (const [key, header] of Object.entries(this.fromHeaders)) {
      const value = headers[header.toLowerCase()]
      if (value !== undefined) entries[key] = value
    }
    return Object.keys(entries).length === 0 ? undefined : entries
  }
}

export default TenantMcpCallMeta
