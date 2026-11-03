/**
 * Tests for session recovery: a server that answers `404` — the Streamable HTTP
 * statement that it no longer has the session this client is using — must get a
 * fresh `initialize` instead of a permanently failing set of tools.
 * Isolated file so the SDK mock (which keeps the real `StreamableHTTPError`
 * class, because classification is an `instanceof` against it) does not disturb
 * the other suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const { mockConnect, mockClose, mockListTools, mockCallTool, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    // The SDK is mocked, so this stands in for a real client: the recovery calls below
    // only ever compare identity, and nothing reads a protocol member off it.
    constructor() { instances.push(this as unknown as Client) }
  }
  const instances: Client[] = []
  return { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

// The real error class stays in place: `isSessionLostSignal` classifies by type.
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>()),
  StreamableHTTPClientTransport: vi.fn(),
}))

import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { resolveReconnectPolicy, startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import { resolveToolConcurrencyPolicy } from '@deepseek-ai/dsh-mcp-client/src/concurrency.ts'

const testToolSignal = new AbortController().signal
const defaultConcurrency = resolveToolConcurrencyPolicy(undefined, 'toolConcurrency')

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function captureLogs(ctx: Context): { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return { warns, errors, infos }
}

function stdioConfig(reconnect?: Config['reconnect']): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

let callSeq = 0
function nextCallId(): CallId {
  return CallId(`session-recovery-${++callSeq}`)
}

/** The refusal a Streamable HTTP server sends for a session it has forgotten. */
function sessionGone(): StreamableHTTPError {
  return new StreamableHTTPError(404, 'Error POSTing to endpoint: Session not found')
}

describe('session recovery', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('re-initializes the session and re-sends the refused call exactly once', async () => {
    const { warns, infos } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockCallTool.mockRejectedValueOnce(sessionGone())
    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__remote', arguments: {},
    })

    // One result reaches the model: the call the server refused, served again
    // through the generation the recovery produced.
    expect(result.isError).toBe(false)
    expect(mockCallTool).toHaveBeenCalledTimes(2)
    expect(instances).toHaveLength(2)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(mockClose).toHaveBeenCalledTimes(1)
    // The stale generation is treated as the ordinary disconnect it became.
    expect(warns.some(line => line.includes('reconnecting in 5ms (attempt 1/5)'))).toBe(true)
    expect(infos.some(line => line.includes('reconnected and re-synced tools'))).toBe(true)
  })

  it('fails the call when the replacement session is refused as well', async () => {
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 20, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // One recovery per call: a server that keeps answering 404 is the reconnect
    // policy's outage, not something one waiting call retries forever.
    mockCallTool.mockRejectedValue(sessionGone())
    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__remote', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(mockCallTool).toHaveBeenCalledTimes(2)
    expect(instances).toHaveLength(2)
  })

  it('fails the call with the server refusal when reconnect is disabled', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ enabled: false, initialDelayMs: 5, maxDelayMs: 20 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockCallTool.mockRejectedValue(sessionGone())
    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__remote', arguments: {},
    })

    // No replacement generation is coming, so the caller waits out the policy's
    // longest delay and reports the server's own refusal.
    expect(result.isError).toBe(true)
    expect(mockCallTool).toHaveBeenCalledTimes(1)
    expect(errors.some(line => line.includes('connection lost and reconnect is disabled'))).toBe(true)
  })

  it('settles a waiting call when the reconnect budget is exhausted', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 1 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockCallTool.mockRejectedValue(sessionGone())
    mockConnect.mockRejectedValue(new Error('server gone'))
    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: nextCallId(), name: 'mcp__srv__remote', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(mockCallTool).toHaveBeenCalledTimes(1)
    expect(errors.some(line => line.includes('giving up after 1 consecutive failed reconnect attempts'))).toBe(true)
  })

  it('reports the live generation to a recovery asked about one already replaced', async () => {
    const handle = startConnection(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 20, maxAttempts: 5 }), resolveReconnectPolicy(undefined, 'reconnect'), defaultConcurrency)
    await handle.ready
    const first = instances[0]!
    first.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })

    // A second call from the replaced generation finds the replacement instead
    // of starting a third one.
    await expect(handle.recoverSession(first)).resolves.toBe(instances[1])
    expect(mockConnect).toHaveBeenCalledTimes(2)
    await handle.dispose()
  })

  it('refuses to recover after disposal and releases a pending wait', async () => {
    // Reconnect disabled so the wait can only end through disposal.
    const handle = startConnection(ctx, stdioConfig({ enabled: false, maxDelayMs: 10_000 }), resolveReconnectPolicy({ enabled: false, maxDelayMs: 10_000 }, 'reconnect'), defaultConcurrency)
    await handle.ready
    const current = instances[0]!

    const pending = handle.recoverSession(current)
    const shared = handle.recoverSession(current)
    const disposing = handle.dispose()
    await expect(pending).resolves.toBeUndefined()
    await expect(shared).resolves.toBeUndefined()
    await disposing

    await expect(handle.recoverSession(current)).resolves.toBeUndefined()
  })
})
