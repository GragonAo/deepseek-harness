/**
 * mcp domain contract: the configuration face of the external MCP server
 * registry (`ctx.mcpServers`).
 *
 * Two registers, one shape. `systemServers` and `saveServer`/`removeServer` are
 * the deployment-wide list an administrator owns; `myServers` and
 * `saveMyServer`/`removeMyServer` are the caller's own list. Both are stored in
 * the same medium and merged per session by the mount, so a surface never has to
 * know which list a row came from — every view carries `origin`.
 *
 * Two invariants ride this wire. A connection header value is write-only: views
 * report the header NAMES a row sends and never a value, so a token stored once
 * cannot be read back out of the configuration UI. And the caller's identity is
 * never a payload field: the user methods read the ambient (tenant, user) scope,
 * so no client can name a user it is not.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Concurrency policy as stored for one server. */
export interface McpServerConcurrencyView {
  /** How the mount decides which of the server's tools may run together. */
  policy?: 'annotations' | 'parallel' | 'exclusive'
  /** Upper bound on tool calls in flight to this server. */
  maxConcurrentCalls?: number
  /** Tools that must run alone whatever the policy says. */
  exclusiveTools?: string[]
}

/**
 * One stored server, as a configuration surface reads it.
 *
 * The endpoint is echoed (an administrator must see what is stored) but the
 * headers are not: `headerNames` lists the names and `hasAuthorization` answers
 * the one question a form needs, whether a credential is already configured.
 */
export interface McpServerView {
  /** Namespace this server's tools appear under. */
  serverName: string
  /** Streamable HTTP endpoint. */
  url: string
  /** Header NAMES the row sends. Values never leave the host — a saved credential */
  /** is replayed server-side (see {@link McpProbeInput.serverName}), not transmitted. */
  headerNames: string[]
  /** Whether any header name looks like an authorization header. */
  hasAuthorization: boolean
  /** Per-tool-call timeout, when the row sets one. */
  timeoutMs?: number
  /** Concurrency policy, when the row sets one. */
  toolConcurrency?: McpServerConcurrencyView
  /** Whether the row participates in the effective set. */
  enabled: boolean
  /** Operator-facing description. */
  descr?: string
  /** Last write, ISO-8601. */
  updatedAt: string
  /** Which register the row lives in. */
  origin: 'system' | 'user'
  /**
   * Name the row mounts under — the `mcp__<mountName>__<tool>` prefix a session
   * sees. A user row is prefixed with its owner so two users' identically named
   * servers stay apart.
   */
  mountName: string
}

/** One server as a surface writes it: the whole row, headers included. */
export interface McpServerWrite {
  /** Namespace this server's tools appear under (`[A-Za-z0-9_-]{1,32}`). */
  serverName: string
  /** Streamable HTTP endpoint; `stdio` servers are not representable. */
  url: string
  /**
   * Headers to send. On an update, an omitted map keeps the stored headers and
   * `{}` clears them — the same rule as `llm.updateProvider`'s credential.
   */
  headers?: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  timeoutMs?: number
  /** Concurrency policy for this server's tools. */
  toolConcurrency?: McpServerConcurrencyView
  /** Whether the row participates in the effective set; defaults to true. */
  enabled?: boolean
  /** Operator-facing description. */
  descr?: string
  /**
   * The revision the caller last read. A system write whose revision no longer
   * matches the medium is refused rather than silently overwriting another
   * administrator's change; omitted means "write anyway". The user register has
   * one writer per row and ignores this field.
   */
  expectedRevision?: number
}

/** What one registry read answers. */
export interface McpRegistrySnapshot {
  /** The rows, sorted by server name. */
  servers: McpServerView[]
  /** Revision of that list; echo it back as `expectedRevision` on a write. */
  revision: number
}

/** The caller's own register plus the system register it merges with. */
export interface McpMyServersValue extends McpRegistrySnapshot {
  /** The deployment-wide rows this caller also receives, read-only here. */
  system: McpServerView[]
}
/** One row of the merged set a session would be given. */
export interface McpEffectiveServerView extends McpServerView {
  /** Register the row came from. */
  origin: 'system' | 'user'
  /** Whether this caller would receive it (a disabled row is listed as false). */
  mounted: boolean
}

/** What a live probe learned. */
export interface McpProbeView {
  /** Whether the endpoint completed an MCP handshake. */
  ok: boolean
  /** Whether the endpoint advertises a tool capability. */
  toolsSupported: boolean
  /** Tools it advertises, when the handshake listed them. */
  toolCount?: number
  /** Round-trip time of the probe. */
  latencyMs: number
  /** Why the probe failed, when it did. */
  error?: string
  /** Whether the address was acceptable to the host policy at all. */
  addressAllowed: boolean
}

/** MCP-domain unary methods (the map keys mcp.* of RpcMethodMap). */
export interface McpApi {
  /**
   * List the deployment-wide register. A deployment that mounts no registry
   * answers with an empty list and revision 0 instead of failing, so a surface
   * can render "nothing configured" before anyone configures anything.
   */
  systemServers(request: RpcRequest<{}>): Promise<RpcResponse<McpRegistrySnapshot>>

  /**
   * Store one deployment-wide server, replacing any row of the same name.
   * Live: a running session picks it up at its next step, without a restart.
   */
  saveServer(request: RpcRequest<McpServerWrite>): Promise<RpcResponse<McpRegistrySnapshot>>

  /**
   * Delete one deployment-wide server; an absent name is refused, not ignored.
   * Live: a running session drops the server's tools at its next step.
   */
  removeServer(request: RpcRequest<{ serverName: string; expectedRevision?: number }>): Promise<RpcResponse<McpRegistrySnapshot>>

  /**
   * List the caller's own register together with the system register it merges
   * with. Refused with `user-scope-required` when the call carries no user.
   */
  myServers(request: RpcRequest<{}>): Promise<RpcResponse<McpMyServersValue>>

  /** Store one of the caller's own servers. Same rules and same revision guard. */
  saveMyServer(request: RpcRequest<McpServerWrite>): Promise<RpcResponse<McpRegistrySnapshot>>

  /** Delete one of the caller's own servers. */
  removeMyServer(request: RpcRequest<{ serverName: string; expectedRevision?: number }>): Promise<RpcResponse<McpRegistrySnapshot>>

  /**
   * The merged set this caller would be given in a new session: the system
   * register plus their own, each row marked with where it came from and whether
   * it would be mounted.
   */
  effectiveServers(request: RpcRequest<{}>): Promise<RpcResponse<{ servers: McpEffectiveServerView[] }>>

  /**
   * Test connectivity for the server a surface is configuring, without storing it:
   * one MCP handshake plus `tools/list`, so a form can show "reachable, 12 tools,
   * 180 ms" before the row exists — and a list row can be re-tested without the
   * caller ever holding the credential again.
   *
   * The payload is the form (`url` + `headers`) or a saved row (`serverName`). A
   * saved row's stored headers are replayed on the host side, so a credential is
   * not sent to a browser, and only for that row's own endpoint.
   */
  testConnection(request: RpcRequest<McpProbeInput>): Promise<RpcResponse<McpProbeView>>
}

/** What a connectivity test asks for. */
export interface McpProbeInput {
  /** Endpoint the form holds. Omitted when `serverName` names a saved row. */
  url?: string
  /** Headers the form holds. Omitted means "use the saved row's stored headers". */
  headers?: Record<string, string>
  /**
   * Saved row to test instead of a draft — the caller's own register first, then
   * the deployment register. Its endpoint stands in for an omitted `url`, and its
   * stored headers for omitted `headers`.
   */
  serverName?: string
  /** Probe budget in milliseconds; the host clamps it. */
  timeoutMs?: number
}
