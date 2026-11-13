/**
 * Write-boundary validation for one stored server row: shape, name shape, an
 * HTTP-only endpoint, and — for untrusted writers — a host that cannot reach
 * loopback, private ranges, or a cloud metadata endpoint. A row that fails any
 * rule is rejected before it is stored, so a later mount never has to defend
 * against a document the registry already accepted.
 * @module @deepseek-ai/dsh-mcp-servers/validate
 */

import type { ExternalMcpServerRecord, McpServerConcurrency } from './types.ts'

/** Server names become a tool-name segment, so the client's own rule applies. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Hosts that never name a legitimate third-party MCP server. */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

/** Fields that would mean a `stdio` server, which this registry does not accept. */
const STDIO_FIELDS = ['command', 'args', 'cwd', 'env', 'transport'] as const

/** @returns whether text is a bare IPv4 literal (dotted quad). */
function isIpv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
}

/**
 * Whether an IPv4 literal sits in a range reserved for loopback, a private
 * network, carrier-grade NAT, link-local (cloud metadata lives at 169.254.169.254),
 * or `0.0.0.0` — i.e. an address an untrusted writer must not make the host dial.
 * @param value - dotted-quad IPv4 literal.
 * @returns true when the address is not publicly routable.
 */
function isReservedIpv4(value: string): boolean {
  const octets = value.split('.').map(part => Number(part))
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return a >= 224
}

/**
 * Whether an IPv6 literal (with or without the URL brackets) is loopback,
 * unspecified, unique-local, link-local, or an IPv4-mapped reserved address.
 * @param value - IPv6 literal as `URL.hostname` reports it.
 * @returns true when the address is not publicly routable.
 */
function isReservedIpv6(value: string): boolean {
  const bare = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (bare === '::1' || bare === '::' || bare === '0:0:0:0:0:0:0:1') return true
  if (bare.startsWith('fe8') || bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) return true
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)?.[1]
  if (mapped !== undefined) return isReservedIpv4(mapped)
  return false
}

/**
 * Whether a host must not be dialled by an untrusted writer. Hostnames are
 * matched textually — this is a static guard against the obvious cases, not a
 * substitute for resolving the name and re-checking the address at connect time.
 * @param hostname - `URL.hostname` of the stored endpoint.
 * @returns true when the host is a loopback, private, link-local, or metadata address.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host.startsWith('[') || host.includes(':')) return isReservedIpv6(host)
  if (isIpv4(host)) return isReservedIpv4(host)
  return false
}

/** @returns a string field or throws naming the offending field. */
function requiredString(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${where}: field "${field}" must be a non-empty string`)
  }
  return value
}

/**
 * Normalise the optional header map. Values stay opaque strings: the registry
 * stores what an operator typed and never interprets a credential.
 * @param raw - candidate value.
 * @param where - diagnostic prefix naming the row being validated.
 * @returns a fresh map with string values only.
 */
export function parseHeaders(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${where}: field "headers" must be an object of string values`)
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new TypeError(`${where}: header "${key}" must be a string`)
    }
    if (key.trim() === '') throw new TypeError(`${where}: header names must be non-empty`)
    headers[key] = value
  }
  return headers
}

/**
 * Normalise the optional concurrency policy, keeping only the subset an operator
 * owns so an adaptive setting cannot be smuggled in through the registry.
 * @param raw - candidate value.
 * @param where - diagnostic prefix naming the row being validated.
 * @returns the normalised policy, or undefined when absent.
 */
export function parseConcurrency(raw: unknown, where: string): McpServerConcurrency | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${where}: field "toolConcurrency" must be an object`)
  }
  const source = raw as Record<string, unknown>
  const policy = source['policy']
  if (policy !== undefined && policy !== 'annotations' && policy !== 'parallel' && policy !== 'exclusive') {
    throw new TypeError(`${where}: field "toolConcurrency.policy" must be annotations, parallel, or exclusive`)
  }
  const max = source['maxConcurrentCalls']
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 1024)) {
    throw new TypeError(`${where}: field "toolConcurrency.maxConcurrentCalls" must be an integer between 1 and 1024`)
  }
  const exclusive = source['exclusiveTools']
  if (exclusive !== undefined && (!Array.isArray(exclusive) || exclusive.some(entry => typeof entry !== 'string'))) {
    throw new TypeError(`${where}: field "toolConcurrency.exclusiveTools" must be an array of tool names`)
  }
  const parsed: McpServerConcurrency = {}
  if (policy !== undefined) parsed.policy = policy
  if (max !== undefined) parsed.maxConcurrentCalls = max
  if (exclusive !== undefined) parsed.exclusiveTools = exclusive as string[]
  return Object.keys(parsed).length === 0 ? undefined : parsed
}

/**
 * Validate and normalise one server row.
 *
 * Rejection is total: a caller stores either the returned record or nothing, so
 * the registry can never hold a row a mount would have to reinterpret. `stdio`
 * is refused by field presence (a `command`/`args`/`env` row is a stdio server
 * whatever else it says), and `updatedAt` is ignored on input because the store
 * assigns it.
 * @param raw - candidate row, typically a decoded request body.
 * @param where - diagnostic prefix naming the row being validated.
 * @param options - `allowPrivateHosts` permits loopback/private endpoints, which
 * only an administrator-managed row may do.
 * @returns the validated record, without `updatedAt`.
 */
export function parseServerRecord(
  raw: unknown,
  where: string,
  options: { allowPrivateHosts?: boolean } = {},
): Omit<ExternalMcpServerRecord, 'updatedAt'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${where}: a server record must be an object`)
  }
  const source = raw as Record<string, unknown>
  for (const field of STDIO_FIELDS) {
    if (source[field] !== undefined) {
      throw new TypeError(`${where}: field "${field}" is not supported — only Streamable HTTP servers can be registered`)
    }
  }
  const serverName = requiredString(source, 'serverName', where)
  if (!SERVER_NAME.test(serverName)) {
    throw new TypeError(`${where}: field "serverName" must match ${String(SERVER_NAME)}`)
  }
  const url = requiredString(source, 'url', where)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError(`${where}: field "url" must be an absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${where}: field "url" must use http or https`)
  }
  if (options.allowPrivateHosts !== true && isBlockedHost(parsed.hostname)) {
    // The host is repeated back: a form that rejected a URL must say which part of
    // it was refused, or the reader cannot tell a typo from a policy.
    throw new TypeError(`${where}: field "url" must not point at a loopback, private, link-local, or metadata host (${parsed.hostname})`)
  }
  const timeoutMs = source['timeoutMs']
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)) {
    throw new TypeError(`${where}: field "timeoutMs" must be an integer between 1 and 600000`)
  }
  const enabled = source['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new TypeError(`${where}: field "enabled" must be a boolean`)
  }
  const descr = source['descr']
  if (descr !== undefined && typeof descr !== 'string') {
    throw new TypeError(`${where}: field "descr" must be a string`)
  }
  const record: Omit<ExternalMcpServerRecord, 'updatedAt'> = {
    serverName,
    url,
    headers: parseHeaders(source['headers'], where),
    enabled: enabled ?? true,
  }
  if (timeoutMs !== undefined) record.timeoutMs = timeoutMs
  const toolConcurrency = parseConcurrency(source['toolConcurrency'], where)
  if (toolConcurrency !== undefined) record.toolConcurrency = toolConcurrency
  if (descr !== undefined && descr !== '') record.descr = descr
  return record
}

/**
 * Validate a registry document read back from a medium, keeping the `updatedAt`
 * each row was stored with. A medium is re-validated on load rather than trusted:
 * the rows it returns are what a mount will act on, and a hand-edited document
 * must fail loudly at activation instead of silently changing what a session sees.
 * @param raw - decoded rows, or undefined for an empty registry.
 * @param where - diagnostic prefix naming the registry being read.
 * @param options - forwarded to {@link parseServerRecord}.
 * @returns the validated rows with their stored timestamps.
 */
export function parseStoredList(
  raw: unknown,
  where: string,
  options: { allowPrivateHosts?: boolean } = {},
): ExternalMcpServerRecord[] {
  const rows = parseServerList(raw, where, options)
  const stored = Array.isArray(raw) ? raw : []
  return rows.map((row, index) => {
    const stamp = (stored[index] as Record<string, unknown> | undefined)?.['updatedAt']
    return { ...row, updatedAt: typeof stamp === 'string' ? stamp : new Date(0).toISOString() }
  })
}

/**
 * Validate a whole registry document as one list: every row is validated and no
 * two rows may share a `serverName`.
 * @param raw - decoded list, or undefined for an empty registry.
 * @param where - diagnostic prefix naming the registry being validated.
 * @param options - forwarded to {@link parseServerRecord}.
 * @returns the validated rows in the order given.
 */
export function parseServerList(
  raw: unknown,
  where: string,
  options: { allowPrivateHosts?: boolean } = {},
): Array<Omit<ExternalMcpServerRecord, 'updatedAt'>> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new TypeError(`${where}: "servers" must be an array`)
  const seen = new Set<string>()
  const records: Array<Omit<ExternalMcpServerRecord, 'updatedAt'>> = []
  for (const [index, entry] of raw.entries()) {
    const record = parseServerRecord(entry, `${where}[${index}]`, options)
    if (seen.has(record.serverName)) {
      throw new TypeError(`${where}[${index}]: duplicate serverName ${JSON.stringify(record.serverName)}`)
    }
    seen.add(record.serverName)
    records.push(record)
  }
  return records
}
