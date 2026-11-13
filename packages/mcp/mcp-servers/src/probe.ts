/**
 * Live reachability probe for a draft MCP endpoint.
 *
 * A configuration surface needs a "test this row" answer before saving: whether
 * the endpoint speaks MCP at all, and how many tools it advertises. The probe is
 * deliberately independent of the mounted client — it opens one connection, never
 * registers anything, and imports no tools — so testing a server cannot change
 * what any session sees.
 *
 * The host policy is part of the probe, not of the caller: a user-facing probe
 * refuses loopback and private addresses exactly as saving does, so probing
 * cannot reach an intranet endpoint that could not be stored.
 * @module @deepseek-ai/dsh-mcp-servers/probe
 */

import { isBlockedHost } from './validate.ts'

/** MCP protocol revision this probe speaks. */
const PROTOCOL_VERSION = '2025-06-18'

/** Default probe budget. */
const DEFAULT_TIMEOUT_MS = 10_000

/** Most tool-list pages followed before the count is reported as a lower bound. */
const MAX_TOOL_PAGES = 5

/** What one probe learned about the endpoint. */
export interface McpProbeResult {
  /** Whether the endpoint completed an MCP handshake. */
  ok: boolean
  /** Tools the endpoint advertises, when the handshake listed them. */
  toolCount?: number
  /** Whether the endpoint declared a tool capability at all. */
  toolsSupported: boolean
  /** Round-trip time of the whole probe. */
  latencyMs: number
  /** Why the probe failed; absent when it succeeded. */
  error?: string
}

/** One JSON-RPC reply, reduced to what the probe reads. */
interface JsonRpcReply {
  result?: {
    capabilities?: { tools?: unknown }
    tools?: unknown[]
    nextCursor?: unknown
  }
  error?: { message?: string }
}

/**
 * Refuse an endpoint address the policy forbids.
 * @param url - the endpoint to check.
 * @param allowPrivateHosts - whether loopback and private ranges are acceptable.
 * @throws when the URL is malformed or points at a forbidden host.
 */
export function assertProbeAddress(url: string, allowPrivateHosts: boolean): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError(`probe: "${url}" is not an absolute URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`probe: endpoint must use http or https, not ${parsed.protocol}`)
  }
  if (!allowPrivateHosts && isBlockedHost(parsed.hostname)) {
    throw new TypeError(`probe: endpoint must not point at a loopback, private, link-local, or metadata host (${parsed.hostname})`)
  }
}

/**
 * Read one JSON-RPC reply out of a response body, plain or event-stream framed.
 * @param text - the response body.
 * @returns the parsed reply.
 */
function parseReply(text: string): JsonRpcReply {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as JsonRpcReply
  // Streamable HTTP may answer a request with an SSE frame; the first `data:`
  // line carrying JSON is the reply this probe asked for.
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload.startsWith('{')) continue
    return JSON.parse(payload) as JsonRpcReply
  }
  throw new SyntaxError(`probe: the endpoint answered with neither JSON nor an event-stream frame (${trimmed.slice(0, 120)})`)
}

/**
 * Probe an MCP endpoint: handshake, then count the tools it advertises.
 *
 * A failed probe is an answer, not an exception: the caller renders `ok: false`
 * with the endpoint's own message. Only a forbidden address throws, because that
 * is a policy refusal rather than something the endpoint said.
 * @param url - endpoint to probe.
 * @param headers - headers the row would send; forwarded verbatim but never returned.
 * @param options - host policy and the probe budget.
 * @returns what the endpoint answered.
 */
export async function probeMcpServer(
  url: string,
  headers: Readonly<Record<string, string>> = {},
  options: { allowPrivateHosts: boolean; timeoutMs?: number } = { allowPrivateHosts: false },
): Promise<McpProbeResult> {
  assertProbeAddress(url, options.allowPrivateHosts)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()
  const signal = AbortSignal.timeout(timeoutMs)
  let sessionId: string | undefined
  const send = async (body: unknown): Promise<JsonRpcReply> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
        ...sessionId === undefined ? {} : { 'mcp-session-id': sessionId },
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      throw new Error(`endpoint answered HTTP ${String(response.status)} ${response.statusText}`.trim())
    }
    const header = response.headers.get('mcp-session-id')
    if (header !== null) sessionId = header
    const reply = parseReply(await response.text())
    if (reply.error !== undefined) throw new Error(reply.error.message ?? 'endpoint answered a JSON-RPC error')
    return reply
  }
  // A notification carries no id and is answered with an empty 202, so it is sent
  // without reading a reply: waiting for one would hang the probe on a spec-
  // compliant server.
  const notify = async (body: unknown): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
        ...sessionId === undefined ? {} : { 'mcp-session-id': sessionId },
      },
      body: JSON.stringify(body),
      signal,
    })
    await response.text()
  }
  try {
    const handshake = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-mcp-probe', version: '1' } },
    })
    // The MCP lifecycle wants the client's initialized notification before the
    // server serves requests; a server that ignores it is unaffected by it.
    await notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const toolsSupported = handshake.result?.capabilities?.tools !== undefined
    if (!toolsSupported) {
      return { ok: true, toolsSupported: false, latencyMs: Date.now() - started }
    }
    let cursor: unknown
    let toolCount = 0
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const listed = await send({
        jsonrpc: '2.0',
        id: page + 2,
        method: 'tools/list',
        ...cursor === undefined ? {} : { params: { cursor } },
      })
      toolCount += listed.result?.tools?.length ?? 0
      cursor = listed.result?.nextCursor
      if (typeof cursor !== 'string' || cursor === '') break
    }
    return { ok: true, toolCount, toolsSupported: true, latencyMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      toolsSupported: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
