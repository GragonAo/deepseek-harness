/**
 * The record an administrator or a user stores for one external MCP server, and
 * the effective entry a mount consumes: `origin`, `ownerId`, and `mountName` are
 * derived at read time and never stored, so a stored record cannot claim an
 * origin it was not written under.
 * @module @deepseek-ai/dsh-mcp-servers/types
 */

/** Which registry a server row lives in. */
export type McpServerOrigin = 'system' | 'user'

/**
 * Concurrency policy for one server's tools. This is the subset an operator may
 * set: the adaptive machinery of the client (retry/decrement/recovery) keeps its
 * own defaults, so a stored row never has to restate them.
 */
export interface McpServerConcurrency {
  /** How the client decides which listed tools may run together. */
  policy?: 'annotations' | 'parallel' | 'exclusive'
  /** Upper bound on calls in flight to this server. */
  maxConcurrentCalls?: number
  /** Tools that must run alone, whatever the policy says. */
  exclusiveTools?: string[]
}

/**
 * One external (Streamable HTTP) MCP server as stored. Every field is
 * normalised: `headers` defaults to an empty map, `timeoutMs` to the client's
 * own default, and `enabled` gates mounting without deleting the row.
 */
export interface ExternalMcpServerRecord {
  /** Namespace the server's tools appear under; unique within its registry. */
  serverName: string
  /** Streamable HTTP endpoint. `stdio` is not representable here on purpose. */
  url: string
  /** Connection-level headers (typically an authorization header). */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  timeoutMs?: number
  /** Per-server concurrency policy. */
  toolConcurrency?: McpServerConcurrency
  /** Whether the row participates in the effective set. */
  enabled: boolean
  /** Operator-facing description; also shown to the model next to the tools. */
  descr?: string
  /** Last write, ISO-8601, assigned by the store. */
  updatedAt: string
}

/** A stored row plus the identity of the registry it came from. */
export interface EffectiveMcpServer extends ExternalMcpServerRecord {
  /** Registry the row was read from. */
  origin: McpServerOrigin
  /** Owning user for a `user` row; absent for a `system` row. */
  ownerId?: string
  /**
   * Name this row is mounted under. A `system` row keeps its own name, so tools
   * of servers that predate this registry keep the names sessions already see; a
   * `user` row is prefixed with its owner, which keeps two users' identically
   * named servers apart and makes the owner visible in a tool name.
   */
  mountName: string
}

/** Validation and quota limits a store enforces on writes. */
export interface McpServerLimits {
  /** Maximum number of `system` rows. */
  maxSystemServers?: number
  /** Maximum number of `user` rows per user. */
  maxUserServers?: number
  /** Whether rows may point at loopback/private/link-local hosts. */
  allowPrivateHosts?: boolean
}
