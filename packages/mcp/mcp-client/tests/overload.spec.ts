/**
 * What one failed `tools/call` says about the server's capacity.
 *
 * Every failure in this suite is built from the classes and codes the SDK and
 * the runtime actually produce, so the classification is pinned against the
 * error a caller receives rather than against a message this package invented.
 * The source of each one is named in `src/overload.ts`.
 */

import { describe, expect, it } from 'vitest'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { isOverloadSignal, type CallFailure } from '@deepseek-ai/dsh-mcp-client/src/overload.ts'

/** Classify one error with the call neither canceled nor counting timeouts. */
function classify(error: unknown, overrides: Partial<CallFailure> = {}): boolean {
  return isOverloadSignal({ error, aborted: false, countTimeouts: true, ...overrides })
}

/** A `fetch` rejection whose reason is a kernel or undici error code. */
function fetchFailed(code: string, depth = 1): TypeError {
  let reason: Error = Object.assign(new Error(`socket closed (${code})`), { code })
  for (let level = 1; level < depth; level += 1) reason = new Error('fetch failed', { cause: reason })
  return new TypeError('fetch failed', { cause: reason })
}

describe('isOverloadSignal', () => {
  it('counts a refused HTTP status and a server error', () => {
    expect(classify(new StreamableHTTPError(429, 'Error POSTing to endpoint: too many connections'))).toBe(true)
    expect(classify(new StreamableHTTPError(503, 'Error POSTing to endpoint: unavailable'))).toBe(true)
    expect(classify(new StreamableHTTPError(500, 'Error POSTing to endpoint: broken'))).toBe(true)
  })

  it('does not count an HTTP status that is about the request', () => {
    for (const status of [400, 401, 403, 404, 405, 422]) {
      expect(classify(new StreamableHTTPError(status, `Error POSTing to endpoint: ${status}`))).toBe(false)
    }
    // The SDK also constructs the error with an unknown status.
    expect(classify(new StreamableHTTPError(undefined, 'Unexpected content type'))).toBe(false)
  })

  it('counts a lost connection and a transport that answered with that code', () => {
    // The client builds the first from its own transport close and the second
    // from a JSON-RPC error response carrying the same code.
    expect(classify(McpError.fromError(ErrorCode.ConnectionClosed, 'Connection closed'))).toBe(true)
    expect(classify(new McpError(ErrorCode.ConnectionClosed, 'too many connections'))).toBe(true)
  })

  it('does not count a JSON-RPC error the server chose for the tool', () => {
    for (const code of [ErrorCode.InternalError, ErrorCode.InvalidParams, ErrorCode.ParseError, -32050]) {
      expect(classify(new McpError(code, 'the tool refused the arguments'))).toBe(false)
    }
    expect(classify(new Error('the tool failed'))).toBe(false)
  })

  it('counts a timeout only when the policy says so', () => {
    const timeout = McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out')
    expect(classify(timeout)).toBe(true)
    expect(classify(timeout, { countTimeouts: false })).toBe(false)
  })

  it('never counts a call the harness canceled', () => {
    // The SDK reports a cancellation as the same code as its own request
    // timeout, so only the call's own signal can tell them apart.
    const canceled = McpError.fromError(ErrorCode.RequestTimeout, 'the tool call was canceled')
    expect(classify(canceled, { aborted: true })).toBe(false)
    expect(classify(McpError.fromError(ErrorCode.ConnectionClosed, 'Connection closed'), { aborted: true })).toBe(false)
    expect(classify(fetchFailed('ECONNRESET'), { aborted: true })).toBe(false)
  })

  it('counts a connection the runtime refused or reset, wherever its code sits', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET']) {
      expect(classify(fetchFailed(code))).toBe(true)
      expect(classify(fetchFailed(code, 3))).toBe(true)
    }
  })

  it('counts an expired wait only when the policy says so', () => {
    for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      expect(classify(fetchFailed(code))).toBe(true)
      expect(classify(fetchFailed(code), { countTimeouts: false })).toBe(false)
    }
  })

  it('does not count a failure that is not about the connection', () => {
    // A missing server binary is misconfiguration, which the reconnect policy
    // reports; DNS says nothing about capacity either.
    for (const code of ['ENOENT', 'EACCES', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(classify(fetchFailed(code))).toBe(false)
    }
  })

  it('walks a bounded cause chain, so a self-referential failure terminates', () => {
    const selfReferential: Record<string, unknown> = { message: 'fetch failed' }
    selfReferential['cause'] = selfReferential
    expect(classify(selfReferential)).toBe(false)

    // A cause five wrappers deep is past the bound and reads as no signal.
    expect(classify(fetchFailed('ECONNREFUSED', 7))).toBe(false)
    expect(classify('not an error at all')).toBe(false)
    expect(classify(undefined)).toBe(false)
  })
})
