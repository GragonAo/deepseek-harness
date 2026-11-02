/**
 * Whether one failed MCP request means the server no longer knows the session
 * this client is using.
 *
 * The Streamable HTTP transport identifies a session with `Mcp-Session-Id`: the
 * server hands one out on `initialize` and expects it back on every later
 * request. The specification answers a request naming a session the server does
 * not have — expired, or lost with the process that created it — with HTTP 404,
 * and says the client MUST start a new session by initializing again. The SDK
 * turns that response into a `StreamableHTTPError` whose `code` is the status
 * (`@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:364`), which is
 * the error a caller of `client.request()` observes.
 *
 * Nothing else in the bridge would ever notice: the transport stayed usable, the
 * client was never closed, so the supervisor sees a live connection and goes on
 * sending a session the server has already forgotten. Classifying the response
 * here is what lets one call turn that state into an ordinary disconnect.
 *
 * A `tools/call` refused this way never reached a tool — the server rejected the
 * session before dispatch — so re-sending it on a fresh session cannot repeat
 * work the tool may already have done.
 *
 * @module
 */

import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** The status the Streamable HTTP specification reserves for a session the server does not have. */
const SESSION_TERMINATED_STATUS = 404

/**
 * Whether a rejection is the server refusing a session this client no longer has.
 *
 * Only the transport's own answer counts. A JSON-RPC error the server chose for
 * the tool says nothing about the session, and a 404 on a transport that never
 * established one is a wrong endpoint, not an expired session.
 *
 * @param error - the rejection one `tools/call` attempt produced.
 * @returns true when the call should be re-sent on a newly initialized session.
 */
export function isSessionLostSignal(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === SESSION_TERMINATED_STATUS
}
