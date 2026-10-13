/**
 * Whether one failed `tools/call` is evidence that the server is refusing load.
 *
 * The server is third-party: it declares nothing about capacity, so the only
 * capacity signal this client has is how a request failed. The classification
 * below is built from the error a caller of `client.request()` actually
 * receives, not from the response the server sent:
 *
 * - A refused HTTP response reaches the caller as `StreamableHTTPError`, whose
 *   `code` is the status of the failed POST
 *   (`@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:12-17`, thrown
 *   at `:364` for any non-2xx POST).
 * - A lost transport reaches every in-flight caller as
 *   `McpError(ErrorCode.ConnectionClosed)` (`shared/protocol.js:263-268`), which
 *   is also what a JSON-RPC error response carrying that code produces
 *   (`shared/protocol.js:459`, `:394-400`).
 * - A request that outlived `toolCallTimeoutMs` reaches the caller as
 *   `McpError(ErrorCode.RequestTimeout)` (`shared/protocol.js:712-714`).
 * - A connection the runtime refused outright (refused, reset, dropped socket)
 *   is not wrapped by the SDK at all: `shared/protocol.js:743-746` rejects with
 *   whatever the transport threw, so the code lives in the error's cause chain.
 *
 * Everything else is the server answering: a tool-level failure is a successful
 * response with `isError: true` (`server/mcp.js:135-141`), a JSON-RPC error is
 * the server's own verdict, and a spawn failure is misconfiguration. None of
 * those say anything about capacity.
 *
 * @module
 */

import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/** HTTP statuses that refuse a request because of load rather than the request itself. */
const REFUSED_HTTP_STATUSES: readonly number[] = [429]

/** Kernel and undici codes for a connection the runtime did not complete. */
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
])

/** Kernel and undici codes for a wait that expired instead of a peer that refused. */
const EXPIRED_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/**
 * How deep to follow `cause` when looking for a transport error code. The chain
 * is built by `fetch` and the runtime, so its depth is not this package's to
 * fix; the bound keeps a self-referential chain finite.
 */
const MAX_CAUSE_DEPTH = 5

// `McpError.code` is typed as a plain number, so the comparison to an ErrorCode
// member is done on the member's numeric value rather than by casting the code.
/** The code the SDK reports for a request that hit its own timeout. */
const REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout

/** The code the SDK reports for a transport it no longer has. */
const CONNECTION_CLOSED_CODE: number = ErrorCode.ConnectionClosed

/** One failed attempt, as the capacity judgement sees it. */
export interface CallFailure {
  /** The rejection the transport, the SDK, or the server produced. */
  readonly error: unknown
  /**
   * Whether the call's own signal was already aborted. A cancellation is
   * evidence about the caller, never about the server, and the SDK reports one
   * as the same `McpError` code as its own request timeout
   * (`shared/protocol.js:685-686`), so this decides before the error type does.
   */
  readonly aborted: boolean
  /** Whether a request that timed out counts as a refusal. */
  readonly countTimeouts: boolean
}

/** Narrow one unknown value to a property bag. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Every error code in one rejection's `cause` chain, outermost first.
 *
 * @param error - The rejection to inspect.
 * @returns The string codes found, in chain order; empty when none is present.
 */
function causeCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (isRecord(current) && typeof current['code'] === 'string') codes.push(current['code'])
    current = isRecord(current) ? current['cause'] : undefined
  }
  return codes
}

/**
 * Whether one failed attempt is a refusal to serve, which is the signal the
 * adaptive cap leans on and the only failure a call is retried for.
 *
 * @param failure - The rejection, the call's cancellation state, and whether timeouts count.
 * @returns True for a refusal to serve; false for a server verdict, a
 *   cancellation, a misconfiguration, or a failure that says nothing about capacity.
 */
export function isOverloadSignal(failure: CallFailure): boolean {
  const { error, aborted, countTimeouts } = failure
  if (aborted) return false
  if (error instanceof McpError) {
    if (error.code === REQUEST_TIMEOUT_CODE) return countTimeouts
    return error.code === CONNECTION_CLOSED_CODE
  }
  if (error instanceof StreamableHTTPError) {
    const status = error.code
    if (status === undefined) return false
    return REFUSED_HTTP_STATUSES.includes(status) || status >= 500
  }
  const codes = causeCodes(error)
  if (codes.some(code => CONNECTION_LOST_CODES.has(code))) return true
  return countTimeouts && codes.some(code => EXPIRED_CODES.has(code))
}
