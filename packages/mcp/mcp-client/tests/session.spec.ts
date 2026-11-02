/**
 * What one failed `tools/call` says about the MCP session it was sent under.
 *
 * Every case is built from the error the SDK actually produces
 * (`StreamableHTTPError` with the failed POST's status), so the classification is
 * pinned against what a caller receives rather than a message this package
 * invented. The source of each one is named in `src/session.ts`.
 */

import { describe, expect, it } from 'vitest'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { isSessionLostSignal } from '@deepseek-ai/dsh-mcp-client/src/session.ts'

describe('isSessionLostSignal', () => {
  it('counts the status the specification reserves for a session the server does not have', () => {
    expect(isSessionLostSignal(new StreamableHTTPError(404, 'Error POSTing to endpoint: Session not found'))).toBe(true)
    expect(isSessionLostSignal(new StreamableHTTPError(404, 'Failed to open SSE stream: Not Found'))).toBe(true)
  })

  it('does not count any other HTTP status', () => {
    for (const status of [400, 401, 403, 409, 429, 500, 503]) {
      expect(isSessionLostSignal(new StreamableHTTPError(status, `Error POSTing to endpoint: ${status}`))).toBe(false)
    }
    // The SDK also constructs the error when the response had no status at all.
    expect(isSessionLostSignal(new StreamableHTTPError(undefined, 'Unexpected content type'))).toBe(false)
  })

  it('does not count a JSON-RPC error the server chose for the call', () => {
    // Servers that are not the one this package is deployed against may answer
    // with a JSON-RPC error instead of 404; that is their verdict, not proof
    // the transport lost the session, so no new session is started for it.
    for (const code of [ErrorCode.InternalError, ErrorCode.ConnectionClosed, ErrorCode.InvalidParams]) {
      expect(isSessionLostSignal(new McpError(code, 'Session not found'))).toBe(false)
    }
  })

  it('does not count a failure that is not a transport answer', () => {
    expect(isSessionLostSignal(new Error('Session not found'))).toBe(false)
    expect(isSessionLostSignal(new TypeError('fetch failed'))).toBe(false)
    expect(isSessionLostSignal('404')).toBe(false)
    expect(isSessionLostSignal(undefined)).toBe(false)
  })
})
