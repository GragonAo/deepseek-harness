/**
 * What `toolConcurrency.mode: 'adaptive'` does to real dispatch.
 *
 * The fixture is a real MCP server over an in-memory transport pair whose
 * `tools/call` handler follows a script: it can refuse a call the way an
 * overloaded backend does (a JSON-RPC error carrying `ConnectionClosed`, which
 * is the code the client turns into an overload signal), hold it open, or never
 * answer it at all. Every assertion about the cap is the server's own observed
 * overlap — how many handlers it ran at the same time — so a limiter that only
 * changed a number without changing dispatch would fail these tests.
 *
 * The recovery window is measured on a clock the test owns, so no assertion
 * depends on how long anything took.
 */

import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createToolCallLimiter, resolveToolConcurrencyPolicy } from '@deepseek-ai/dsh-mcp-client/src/concurrency.ts'
import { syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ToolConcurrencyConfig } from '@deepseek-ai/dsh-mcp-client'

/** Hold every served call open this long, so overlap is observable. */
const HOLD_MS = 25

/** Per-call budget for the hanging fixture's calls, which always outlive it. */
const HANG_TIMEOUT_MS = 40

const testToolSignal = new AbortController().signal

function sleep(ms: number): Promise<void> {
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

let callSeq = 0

/** Execute one fixture tool through the live registry. */
function execute(
  ctx: Context,
  name: string,
  signal: AbortSignal = testToolSignal,
): Promise<{ content: readonly unknown[]; isError: boolean }> {
  callSeq += 1
  return ctx.tools.execute({
    signal,
    callId: CallId(`adaptive-${callSeq}`),
    name,
    arguments: { tag: `t${callSeq}` },
  })
}

/** Require the single text block of one fixture result. */
function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0]
  if (block === null || typeof block !== 'object' || !('text' in block) || typeof block.text !== 'string') {
    throw new Error(`expected a text content block, got ${JSON.stringify(block)}`)
  }
  return block.text
}

/** One fixture call's result, as `<text>:<isError>`. */
function outcome(result: { content: readonly unknown[]; isError: boolean }): string {
  return `${textOf(result)}:${result.isError}`
}

/** Assert one call was refused by the server, and reached the model as an error. */
function expectRefused(result: { content: readonly unknown[]; isError: boolean }): void {
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('too many connections')
}

/** Assert one call was served, carrying the tag it was sent with. */
function expectServed(result: { content: readonly unknown[]; isError: boolean }, tool: string): void {
  expect(result.isError).toBe(false)
  expect(textOf(result)).toMatch(new RegExp(`^${tool}:t\\d+$`))
}

/** What one fixture server does with the calls it receives. */
interface Script {
  /** Calls refused with a `ConnectionClosed` JSON-RPC error before calls are served. */
  refusals: number
  /** Never answer, so each call outlives `toolCallTimeoutMs`. */
  hang?: boolean
}

/** What one fixture server observed, per test phase. */
interface Ledger {
  /** Handlers running right now. */
  inFlight: number
  /** Highest `inFlight` reached since the phase began. */
  peak: number
  /** `tools/call` requests the server received, so retries are countable. */
  arrivals: number
  /** Highest `peak` of the whole test. */
  highWater: number
  /** Start a phase: forget the previous phase's handlers, including hung ones. */
  beginPhase(): void
}

function newLedger(): Ledger {
  return {
    inFlight: 0,
    peak: 0,
    arrivals: 0,
    highWater: 0,
    beginPhase() {
      // A hung handler never returns, so its decrement never arrives; the phase
      // boundary is the only place that can forget it.
      this.inFlight = 0
      this.peak = 0
    },
  }
}

/** One fixture server plus the clock the test owns for its recovery window. */
interface Fixture {
  ctx: Context
  ledger: Ledger
  script: Script
  advance(ms: number): void
  close(): Promise<void>
}

/** The tag argument every fixture tool takes. */
const TAG_SCHEMA = {
  type: 'object',
  properties: { tag: { type: 'string' } },
  required: ['tag'],
}

/**
 * Start a scripted MCP server, bridge it onto a live registry under `serverName`,
 * and report the overlap the server itself observed.
 *
 * @param concurrency - Raw `toolConcurrency` config for this server.
 * @param script - What the server does with each call; the test mutates it between phases.
 * @param toolCallTimeoutMs - Per-call request budget; `HANG_TIMEOUT_MS` for the timeout cases.
 * @returns The fixture handle, including the clock driving the recovery window.
 */
async function startFixture(
  concurrency: ToolConcurrencyConfig,
  script: Script,
  toolCallTimeoutMs = 60_000,
): Promise<Fixture> {
  const ledger = newLedger()
  let clock = 0
  // A high-level server whose request handlers are set on the low-level server
  // it owns: a refusal has to be a JSON-RPC error, and `registerTool` would turn
  // a thrown error into an `isError` result the client reads as an answer.
  const server = new McpServer({ name: 'adaptive-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'read',
        description: 'Reads a tag.',
        inputSchema: TAG_SCHEMA,
        annotations: { readOnlyHint: true },
      },
      {
        name: 'write',
        description: 'Writes a tag.',
        inputSchema: TAG_SCHEMA,
      },
    ],
  }))
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requested = request.params.arguments?.['tag']
    const tag = typeof requested === 'string' ? requested : ''
    ledger.arrivals += 1
    ledger.inFlight += 1
    ledger.peak = Math.max(ledger.peak, ledger.inFlight)
    ledger.highWater = Math.max(ledger.highWater, ledger.peak)
    if (script.hang === true) {
      // The caller's timeout is what ends this one; the handler never settles.
      await new Promise(() => { /* never answers */ })
    }
    await sleep(HOLD_MS)
    ledger.inFlight -= 1
    if (script.refusals > 0) {
      script.refusals -= 1
      // A refused call, reported the way an overloaded backend reports one: a
      // JSON-RPC error whose code the client reads as a lost connection.
      throw new McpError(ErrorCode.ConnectionClosed, 'too many connections')
    }
    return { content: [{ type: 'text' as const, text: `${request.params.name}:${tag}` }] }
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'adaptive-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const policy = resolveToolConcurrencyPolicy(concurrency, 'toolConcurrency')
  await syncTools(client, ctx, {
    registrationFailure: 'contain',
    serverName: 'srv',
    toolCallTimeoutMs,
    concurrency: policy,
    limiter: createToolCallLimiter(policy, { now: () => clock }),
  } satisfies ToolBridgeOptions, new Map())

  return {
    ctx,
    ledger,
    script,
    advance: (ms: number) => { clock += ms },
    async close() {
      await client.close()
      await server.close()
    },
  }
}

/**
 * Run one phase of `count` calls to `tool` dispatched at once, and report the
 * server's own peak overlap for that phase.
 *
 * @param fixture - The running fixture.
 * @param tool - Public tool name to call.
 * @param count - Calls to dispatch together.
 * @returns The phase's server-observed peak and each call's outcome.
 */
async function phase(
  fixture: Fixture,
  tool: string,
  count: number,
): Promise<{ peak: number; outcomes: string[] }> {
  fixture.ledger.beginPhase()
  const results = await Promise.all(Array.from({ length: count }, () => execute(fixture.ctx, tool)))
  return { peak: fixture.ledger.peak, outcomes: results.map(outcome) }
}

describe('adaptive cap: refusals lower the cap the server observes', () => {
  it('multiplies the cap down per refusal and stops at one call at a time', async () => {
    const fixture = await startFixture(
      { policy: 'parallel', mode: 'adaptive', maxConcurrentCalls: 8 },
      { refusals: 24 },
    )
    try {
      // Eight independent calls go out at once, because the cap starts at eight.
      const first = await phase(fixture, 'mcp__srv__read', 8)
      expect(first.peak).toBe(8)
      expect(first.outcomes.every(text => text.endsWith(':true'))).toBe(true)

      // Eight refusals drove the cap to one, so the next phase runs one at a time.
      const second = await phase(fixture, 'mcp__srv__read', 8)
      expect(second.peak).toBe(1)

      // A cap of one is the floor: refusals never stop the calls being sent.
      const third = await phase(fixture, 'mcp__srv__read', 8)
      expect(third.peak).toBe(1)
      expect(third.outcomes).toHaveLength(8)
      expect(fixture.ledger.arrivals).toBe(24)
      expect(fixture.ledger.highWater).toBe(8)
    } finally {
      await fixture.close()
    }
  })

  it('keeps the cap at maxConcurrentCalls in fixed mode', async () => {
    const fixture = await startFixture(
      { policy: 'parallel', mode: 'fixed', maxConcurrentCalls: 4 },
      { refusals: 4 },
    )
    try {
      expect((await phase(fixture, 'mcp__srv__read', 4)).peak).toBe(4)
      // Nothing was learned: the next phase overlaps exactly as much as the first.
      expect((await phase(fixture, 'mcp__srv__read', 4)).peak).toBe(4)
    } finally {
      await fixture.close()
    }
  })
})

describe('adaptive cap: successful calls recover it', () => {
  it('drops the cap, then adds one slot per quiet window back to the configured cap', async () => {
    // More calls than the cap, so the queue keeps the cap full in every phase:
    // the server's peak then reports the cap itself rather than the dispatch
    // order of one wave.
    const fixture = await startFixture(
      {
        policy: 'parallel',
        mode: 'adaptive',
        maxConcurrentCalls: 4,
        recoveryQuietMs: 1_000,
      },
      { refusals: 8 },
    )
    try {
      const refused = await phase(fixture, 'mcp__srv__read', 8)
      expect(refused.peak).toBe(4)
      expect(refused.outcomes.every(text => text.endsWith(':true'))).toBe(true)

      // Inside the quiet window the cap stays down: this is the drop, measured on
      // the server rather than read off the limiter.
      const stillDown = await phase(fixture, 'mcp__srv__read', 8)
      expect(stillDown.peak).toBe(1)
      expect(stillDown.outcomes.every(text => text.endsWith(':false'))).toBe(true)

      fixture.advance(1_000)
      expect((await phase(fixture, 'mcp__srv__read', 8)).peak).toBe(2)

      fixture.advance(1_000)
      expect((await phase(fixture, 'mcp__srv__read', 8)).peak).toBe(3)

      fixture.advance(1_000)
      expect((await phase(fixture, 'mcp__srv__read', 8)).peak).toBe(4)

      // Recovered to the configured cap, which stays a ceiling: the server never
      // saw more overlap than the configuration allows.
      fixture.advance(10_000)
      expect((await phase(fixture, 'mcp__srv__read', 8)).peak).toBe(4)
      expect(fixture.ledger.highWater).toBe(4)
    } finally {
      await fixture.close()
    }
  })
})

describe('adaptive cap: what counts as a refusal', () => {
  it('counts a call that timed out, which lowers the cap', async () => {
    const fixture = await startFixture(
      { policy: 'parallel', mode: 'adaptive', maxConcurrentCalls: 4, countTimeouts: true },
      { refusals: 0, hang: true },
      HANG_TIMEOUT_MS,
    )
    try {
      const hung = await phase(fixture, 'mcp__srv__read', 4)
      expect(hung.outcomes.every(text => text.includes('timed out') && text.endsWith(':true'))).toBe(true)

      fixture.script.hang = false
      // Four timeouts drove the cap to one.
      expect((await phase(fixture, 'mcp__srv__read', 4)).peak).toBe(1)
    } finally {
      await fixture.close()
    }
  })

  it('does not count a call that timed out when countTimeouts is false', async () => {
    const fixture = await startFixture(
      { policy: 'parallel', mode: 'adaptive', maxConcurrentCalls: 4, countTimeouts: false },
      { refusals: 0, hang: true },
      HANG_TIMEOUT_MS,
    )
    try {
      const hung = await phase(fixture, 'mcp__srv__read', 4)
      expect(hung.outcomes.every(text => text.endsWith(':true'))).toBe(true)

      fixture.script.hang = false
      // The cap is untouched: a slow server is not an overloaded one.
      expect((await phase(fixture, 'mcp__srv__read', 4)).peak).toBe(4)
    } finally {
      await fixture.close()
    }
  })
})

describe('retry after a refusal', () => {
  it('retries a read-only tool until it is served', async () => {
    const fixture = await startFixture(
      {
        policy: 'parallel',
        mode: 'adaptive',
        maxConcurrentCalls: 4,
        retryAttempts: 2,
        retryBaseDelayMs: 1,
        retryJitterRatio: 0,
      },
      { refusals: 2 },
    )
    try {
      const result = await execute(fixture.ctx, 'mcp__srv__read')
      expectServed(result, 'read')
      // Two refusals and one served attempt: three requests, one model-visible result.
      expect(fixture.ledger.arrivals).toBe(3)
    } finally {
      await fixture.close()
    }
  })

  it('never retries a tool that is neither read-only nor listed in retryTools', async () => {
    const fixture = await startFixture(
      {
        policy: 'parallel',
        mode: 'adaptive',
        maxConcurrentCalls: 4,
        retryAttempts: 3,
        retryBaseDelayMs: 1,
        retryJitterRatio: 0,
      },
      { refusals: 4 },
    )
    try {
      // An empty retryTools list with a budget of three: the write's annotation
      // says nothing about repeats, so it is sent once and its refusal reaches
      // the model. This is the fail-safe default, stated as an arrival count.
      expectRefused(await execute(fixture.ctx, 'mcp__srv__write'))
      expect(fixture.ledger.arrivals).toBe(1)

      // The same server's read-only tool uses the same budget, so what decided
      // was the tool's own annotation and not the budget being ignored.
      expectServed(await execute(fixture.ctx, 'mcp__srv__read'), 'read')
      expect(fixture.ledger.arrivals).toBe(5)
    } finally {
      await fixture.close()
    }
  })

  it('retries a listed tool that is not read-only', async () => {
    const fixture = await startFixture(
      {
        policy: 'parallel',
        mode: 'adaptive',
        maxConcurrentCalls: 4,
        retryTools: ['write'],
        retryAttempts: 2,
        retryBaseDelayMs: 1,
        retryJitterRatio: 0,
      },
      { refusals: 2 },
    )
    try {
      // The deployment stated that repeating this write is safe, which is the
      // only way a non-read-only tool is retried.
      expectServed(await execute(fixture.ctx, 'mcp__srv__write'), 'write')
      expect(fixture.ledger.arrivals).toBe(3)
    } finally {
      await fixture.close()
    }
  })

  it('retries a listed tool that is also kept serial', async () => {
    const fixture = await startFixture(
      {
        policy: 'parallel',
        mode: 'adaptive',
        maxConcurrentCalls: 4,
        exclusiveTools: ['read'],
        retryTools: ['read'],
        retryAttempts: 2,
        retryBaseDelayMs: 1,
        retryJitterRatio: 0,
      },
      { refusals: 2 },
    )
    try {
      // The two lists are independent: preserving a call's submission order says
      // nothing about whether it may be sent again.
      expectServed(await execute(fixture.ctx, 'mcp__srv__read'), 'read')
      expect(fixture.ledger.arrivals).toBe(3)
    } finally {
      await fixture.close()
    }
  })

  it('bounds the attempts at retryAttempts', async () => {
    const fixture = await startFixture(
      {
        policy: 'parallel',
        mode: 'adaptive',
        maxConcurrentCalls: 4,
        retryAttempts: 1,
        retryBaseDelayMs: 1,
        retryJitterRatio: 0,
      },
      { refusals: 5 },
    )
    try {
      expectRefused(await execute(fixture.ctx, 'mcp__srv__read'))
      expect(fixture.ledger.arrivals).toBe(2)
    } finally {
      await fixture.close()
    }
  })

  it('retries nothing while the budget is zero, however the tool is classified', async () => {
    const fixture = await startFixture(
      { policy: 'parallel', mode: 'adaptive', maxConcurrentCalls: 4, retryTools: ['write'] },
      { refusals: 5 },
    )
    try {
      expectRefused(await execute(fixture.ctx, 'mcp__srv__read'))
      expectRefused(await execute(fixture.ctx, 'mcp__srv__write'))
      expect(fixture.ledger.arrivals).toBe(2)
    } finally {
      await fixture.close()
    }
  })

  it('stops waiting for a retry when the call is canceled', async () => {
    const fixture = await startFixture(
      {
        policy: 'parallel',
        mode: 'adaptive',
        maxConcurrentCalls: 4,
        retryAttempts: 2,
        retryBaseDelayMs: 30_000,
        retryJitterRatio: 0,
      },
      { refusals: 5 },
    )
    try {
      const controller = new AbortController()
      const pending = execute(fixture.ctx, 'mcp__srv__read', controller.signal)
      setTimeout(() => { controller.abort(new Error('the tool call timed out')) }, 50)

      const result = await pending
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('canceled while waiting to retry')
      // The retry never reached the server: the 30s backoff was abandoned.
      expect(fixture.ledger.arrivals).toBe(1)
    } finally {
      await fixture.close()
    }
  })
})
