/**
 * MCP tool-call concurrency: annotation-based classification, the
 * `toolConcurrency` override, and the per-server call cap.
 *
 * The fixture is a real MCP server over an in-memory transport pair, so the
 * peak-overlap assertions measure concurrent request handling in the SDK
 * rather than a mock's bookkeeping: a transport or client that served one
 * request at a time would report a peak of 1 whatever the policy says.
 */

import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  allowsAutomaticRetry,
  allowsConcurrentCalls,
  createToolCallLimiter,
  resolveToolConcurrencyPolicy,
  retryDelayMs,
  waitBeforeRetry,
} from '@deepseek-ai/dsh-mcp-client/src/concurrency.ts'
import { syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ConcurrencyLimiter, ToolConcurrencyConfig } from '@deepseek-ai/dsh-mcp-client'

const testToolSignal = new AbortController().signal

/** Hold every fixture call open this long, so overlap is observable. */
const HOLD_MS = 60

function sleep(ms: number): Promise<void> {
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

let callSeq = 0

function execute(ctx: Context, name: string, args: unknown = {}): Promise<{ content: readonly unknown[]; isError: boolean }> {
  return ctx.tools.execute({ signal: testToolSignal, callId: CallId(`concurrency-${++callSeq}`), name, arguments: args })
}

/** Require the single text block of one fixture result. */
function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0]
  if (block === null || typeof block !== 'object' || !('text' in block) || typeof block.text !== 'string') {
    throw new Error(`expected a text content block, got ${JSON.stringify(block)}`)
  }
  return block.text
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** One fixture server's observable call load. */
interface Fixture {
  ctx: Context
  /** Highest number of `tools/call` handlers the server ran at the same time. */
  peak(): number
  /** Handler entry order, recorded as `<tool>:<tag>`. */
  order(): string[]
  close(): Promise<void>
}

/**
 * Start a real MCP server advertising four tools that differ only in their
 * annotations, bridge it onto a live registry under `serverName`, and report
 * the overlap the server actually observed.
 */
async function startFixture(concurrency?: ToolConcurrencyConfig, serverName = 'srv'): Promise<Fixture> {
  let inFlight = 0
  let peak = 0
  const order: string[] = []
  const respond = async (tool: string, tag: string) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    order.push(`${tool}:${tag}`)
    await sleep(HOLD_MS)
    inFlight -= 1
    return { content: [{ type: 'text' as const, text: `${tool}:${tag}` }] }
  }

  const server = new McpServer({ name: 'concurrency-fixture', version: '1.0.0' })
  const shape = { tag: z.string() }
  server.registerTool('read', {
    description: 'Reads a tag.',
    inputSchema: shape,
    annotations: { readOnlyHint: true },
  }, async args => respond('read', args.tag))
  server.registerTool('write', {
    description: 'Writes a tag.',
    inputSchema: shape,
  }, async args => respond('write', args.tag))
  server.registerTool('idem', {
    description: 'Applies a tag idempotently.',
    inputSchema: shape,
    annotations: { idempotentHint: true },
  }, async args => respond('idem', args.tag))
  server.registerTool('unsafe', {
    description: 'Destroys a tag.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async args => respond('unsafe', args.tag))

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'concurrency-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const ctx = await mountRegistry()
  const policy = resolveToolConcurrencyPolicy(concurrency, 'toolConcurrency')
  await syncTools(client, ctx, {
    registrationFailure: 'contain',
    serverName,
    toolCallTimeoutMs: 60_000,
    concurrency: policy,
    limiter: createToolCallLimiter(policy),
  } satisfies ToolBridgeOptions, new Map())

  return {
    ctx,
    peak: () => peak,
    order: () => [...order],
    async close() {
      await client.close()
      await server.close()
    },
  }
}

/** The runtime's scheduling classification for one registered tool. */
function modeOf(ctx: Context, publicName: string): string {
  return ctx.tools.executionMode({
    signal: testToolSignal,
    callId: CallId('mode'),
    name: publicName,
    arguments: {},
  }).kind
}

// ---- Tests ----

describe('annotation-based concurrency classification', () => {
  it('classifies a readOnlyHint tool and an idempotentHint tool as parallel', async () => {
    const fixture = await startFixture()
    try {
      expect(modeOf(fixture.ctx, 'mcp__srv__read')).toBe('parallel')
      expect(modeOf(fixture.ctx, 'mcp__srv__idem')).toBe('parallel')
    } finally {
      await fixture.close()
    }
  })

  it('classifies a tool with no annotations, and one denying read-only, as exclusive', async () => {
    const fixture = await startFixture()
    try {
      expect(modeOf(fixture.ctx, 'mcp__srv__write')).toBe('exclusive')
      expect(modeOf(fixture.ctx, 'mcp__srv__unsafe')).toBe('exclusive')
    } finally {
      await fixture.close()
    }
  })

  it('overrides annotations with toolConcurrency.policy: parallel', async () => {
    const fixture = await startFixture({ policy: 'parallel' })
    try {
      expect(modeOf(fixture.ctx, 'mcp__srv__write')).toBe('parallel')
      expect(modeOf(fixture.ctx, 'mcp__srv__unsafe')).toBe('parallel')
    } finally {
      await fixture.close()
    }
  })

  it('overrides annotations with toolConcurrency.policy: exclusive', async () => {
    const fixture = await startFixture({ policy: 'exclusive' })
    try {
      expect(modeOf(fixture.ctx, 'mcp__srv__read')).toBe('exclusive')
      expect(modeOf(fixture.ctx, 'mcp__srv__idem')).toBe('exclusive')
    } finally {
      await fixture.close()
    }
  })

  it('applies each server its own policy', async () => {
    const forced = await startFixture({ policy: 'parallel' }, 'forced')
    const trusted = await startFixture(undefined, 'trusted')
    try {
      expect(modeOf(forced.ctx, 'mcp__forced__write')).toBe('parallel')
      expect(modeOf(trusted.ctx, 'mcp__trusted__write')).toBe('exclusive')
      expect(modeOf(trusted.ctx, 'mcp__trusted__read')).toBe('parallel')
    } finally {
      await forced.close()
      await trusted.close()
    }
  })

  it('excludes exactly the tools exclusiveTools names, whatever the policy says', async () => {
    const fixture = await startFixture({ policy: 'parallel', exclusiveTools: ['write', 'read'] })
    try {
      expect(modeOf(fixture.ctx, 'mcp__srv__write')).toBe('exclusive')
      // A positive `readOnlyHint` does not survive the list: the deployment
      // knows which of a third-party server's tools mutate, not the server.
      expect(modeOf(fixture.ctx, 'mcp__srv__read')).toBe('exclusive')
      expect(modeOf(fixture.ctx, 'mcp__srv__idem')).toBe('parallel')
      expect(modeOf(fixture.ctx, 'mcp__srv__unsafe')).toBe('parallel')
    } finally {
      await fixture.close()
    }
  })

  it('excludes the named tools of one server only', async () => {
    const listed = await startFixture({ policy: 'parallel', exclusiveTools: ['write'] }, 'listed')
    const other = await startFixture({ policy: 'parallel' }, 'other')
    try {
      expect(modeOf(listed.ctx, 'mcp__listed__write')).toBe('exclusive')
      expect(modeOf(listed.ctx, 'mcp__listed__read')).toBe('parallel')
      expect(modeOf(other.ctx, 'mcp__other__write')).toBe('parallel')
    } finally {
      await listed.close()
      await other.close()
    }
  })
})

describe('per-server call cap', () => {
  it('overlaps annotated calls and reports the peak in flight', async () => {
    const fixture = await startFixture()
    try {
      const results = await Promise.all([1, 2, 3, 4].map(n => execute(fixture.ctx, 'mcp__srv__read', { tag: `t${n}` })))

      // Four overlapping requests, none of them serialized behind another.
      expect(fixture.peak()).toBe(4)
      expect(results.map(textOf)).toEqual(['read:t1', 'read:t2', 'read:t3', 'read:t4'])
    } finally {
      await fixture.close()
    }
  })

  it('never runs more than maxConcurrentCalls requests at once', async () => {
    const fixture = await startFixture({ maxConcurrentCalls: 2 })
    try {
      const results = await Promise.all([1, 2, 3, 4, 5].map(n => execute(fixture.ctx, 'mcp__srv__read', { tag: `t${n}` })))

      expect(fixture.peak()).toBe(2)
      expect(results.map(textOf)).toEqual(['read:t1', 'read:t2', 'read:t3', 'read:t4', 'read:t5'])
    } finally {
      await fixture.close()
    }
  })

  it('caps each server independently', async () => {
    const first = await startFixture({ maxConcurrentCalls: 1 }, 'first')
    const second = await startFixture({ maxConcurrentCalls: 1 }, 'second')
    try {
      const results = await Promise.all([
        execute(first.ctx, 'mcp__first__read', { tag: 'a' }),
        execute(second.ctx, 'mcp__second__read', { tag: 'b' }),
        execute(first.ctx, 'mcp__first__read', { tag: 'c' }),
        execute(second.ctx, 'mcp__second__read', { tag: 'd' }),
      ])

      // Each server ran one request at a time; both servers ran one at a time
      // together, which one shared cap would have prevented.
      expect(first.peak()).toBe(1)
      expect(second.peak()).toBe(1)
      expect(results.map(textOf)).toEqual(['read:a', 'read:b', 'read:c', 'read:d'])
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('serves queued calls in submission order through a cap of one', async () => {
    const fixture = await startFixture({ maxConcurrentCalls: 1 })
    try {
      const results = await Promise.all([1, 2, 3].map(n => execute(fixture.ctx, 'mcp__srv__read', { tag: `t${n}` })))

      expect(fixture.peak()).toBe(1)
      expect(fixture.order()).toEqual(['read:t1', 'read:t2', 'read:t3'])
      expect(results.map(textOf)).toEqual(['read:t1', 'read:t2', 'read:t3'])
    } finally {
      await fixture.close()
    }
  })

  it('does not mix results between overlapping calls of different tools', async () => {
    const fixture = await startFixture({ policy: 'parallel', maxConcurrentCalls: 4 })
    try {
      const results = await Promise.all([
        execute(fixture.ctx, 'mcp__srv__read', { tag: 'one' }),
        execute(fixture.ctx, 'mcp__srv__write', { tag: 'two' }),
        execute(fixture.ctx, 'mcp__srv__idem', { tag: 'three' }),
        execute(fixture.ctx, 'mcp__srv__unsafe', { tag: 'four' }),
      ])

      expect(fixture.peak()).toBe(4)
      expect(results.map(textOf)).toEqual(['read:one', 'write:two', 'idem:three', 'unsafe:four'])
    } finally {
      await fixture.close()
    }
  })
})

describe('resolveToolConcurrencyPolicy', () => {
  const path = 'mcp-client(srv): toolConcurrency'

  it('resolves omission to the defaults, frozen', () => {
    const policy = resolveToolConcurrencyPolicy(undefined, path)
    expect(policy).toEqual({
      policy: 'annotations',
      maxConcurrentCalls: 10,
      exclusiveTools: new Set(),
      retryTools: new Set(),
      mode: 'adaptive',
      decreaseFactor: 0.5,
      recoveryStep: 1,
      recoveryQuietMs: 2_000,
      countTimeouts: true,
      retryAttempts: 0,
      retryBaseDelayMs: 200,
      retryJitterRatio: 0.2,
    })
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('keeps explicit values', () => {
    const policy = resolveToolConcurrencyPolicy({
      policy: 'parallel',
      maxConcurrentCalls: 3,
      mode: 'fixed',
      decreaseFactor: 0.25,
      recoveryStep: 2,
      recoveryQuietMs: 250,
      countTimeouts: false,
      retryAttempts: 4,
      retryBaseDelayMs: 10,
      retryJitterRatio: 0,
    }, path)
    expect(policy).toEqual({
      policy: 'parallel',
      maxConcurrentCalls: 3,
      exclusiveTools: new Set(),
      retryTools: new Set(),
      mode: 'fixed',
      decreaseFactor: 0.25,
      recoveryStep: 2,
      recoveryQuietMs: 250,
      countTimeouts: false,
      retryAttempts: 4,
      retryBaseDelayMs: 10,
      retryJitterRatio: 0,
    })
  })

  it('resolves exclusiveTools and retryTools to independent membership sets', () => {
    const policy = resolveToolConcurrencyPolicy(
      { exclusiveTools: ['write', 'read'], retryTools: ['read'] },
      path,
    )
    expect(policy.exclusiveTools).toEqual(new Set(['write', 'read']))
    expect(policy.retryTools).toEqual(new Set(['read']))
    // A tool that needs both properties keeps both, and neither list implies the other.
    expect(policy.exclusiveTools.has('write')).toBe(true)
    expect(policy.retryTools.has('write')).toBe(false)
    expect(policy.retryTools.has('read')).toBe(true)
  })

  it('treats an empty exclusiveTools or retryTools list as naming nothing', () => {
    // Schemastery materializes an absent array key as `[]`, so this is also the
    // value every config without the option resolves to; there is no referent to
    // judge, and the unknown-name check covers the real failure mode.
    const policy = resolveToolConcurrencyPolicy({ exclusiveTools: [], retryTools: [] }, path)
    expect(policy.exclusiveTools.size).toBe(0)
    expect(policy.retryTools.size).toBe(0)
  })

  it('rejects an exclusiveTools entry that names no tool', () => {
    for (const exclusiveTools of [[''], ['  '], ['write', '']]) {
      expect(() => resolveToolConcurrencyPolicy({ exclusiveTools }, path))
        .toThrow(/exclusiveTools must name non-empty tool names/)
    }
  })

  it('rejects a retryTools entry that names no tool', () => {
    for (const retryTools of [[''], ['  '], ['read', '']]) {
      expect(() => resolveToolConcurrencyPolicy({ retryTools }, path))
        .toThrow(/retryTools must name non-empty tool names/)
    }
  })

  it('rejects unknown keys', () => {
    expect(() => resolveToolConcurrencyPolicy(
      { policy: 'parallel', jitterRatio: 0.5 } as never,
      path,
    )).toThrow(/toolConcurrency\.jitterRatio is not a tool-concurrency option/)
  })

  it('rejects an unknown policy', () => {
    // Reachable only by programmatic construction: the Config union rejects
    // this value before the resolver sees it.
    expect(() => resolveToolConcurrencyPolicy({ policy: 'trusting' } as never, path))
      .toThrow(/must be one of annotations, parallel, exclusive/)
  })

  it('rejects a cap that is not a positive integer', () => {
    for (const maxConcurrentCalls of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveToolConcurrencyPolicy({ maxConcurrentCalls }, path))
        .toThrow(/maxConcurrentCalls must be a positive integer/)
    }
  })

  it('rejects an unknown mode', () => {
    // Reachable only by programmatic construction: the Config union rejects this
    // value before the resolver sees it.
    expect(() => resolveToolConcurrencyPolicy({ mode: 'elastic' } as never, path))
      .toThrow(/mode must be one of fixed, adaptive/)
  })

  it('rejects a decrease factor outside the open 0..1 interval', () => {
    for (const decreaseFactor of [0, 1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveToolConcurrencyPolicy({ decreaseFactor }, path))
        .toThrow(/decreaseFactor must be greater than 0 and less than 1/)
    }
    expect(resolveToolConcurrencyPolicy({ decreaseFactor: 0.999 }, path).decreaseFactor).toBe(0.999)
  })

  it('rejects a recovery step that is not a positive integer', () => {
    for (const recoveryStep of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveToolConcurrencyPolicy({ recoveryStep }, path))
        .toThrow(/recoveryStep must be a positive integer/)
    }
  })

  it('rejects a recovery window outside the timer range', () => {
    for (const recoveryQuietMs of [0, -1, 1.5, Number.NaN, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => resolveToolConcurrencyPolicy({ recoveryQuietMs }, path))
        .toThrow(/recoveryQuietMs must be an integer in 1\.\./)
    }
  })

  it('rejects a non-boolean countTimeouts', () => {
    expect(() => resolveToolConcurrencyPolicy({ countTimeouts: 'yes' } as never, path))
      .toThrow(/countTimeouts must be a boolean/)
  })

  it('rejects a retry budget outside 0..5', () => {
    expect(resolveToolConcurrencyPolicy({ retryAttempts: 0 }, path).retryAttempts).toBe(0)
    expect(resolveToolConcurrencyPolicy({ retryAttempts: 5 }, path).retryAttempts).toBe(5)
    for (const retryAttempts of [-1, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveToolConcurrencyPolicy({ retryAttempts }, path))
        .toThrow(/retryAttempts must be an integer in 0\.\.5/)
    }
  })

  it('rejects a retry delay outside the timer range', () => {
    for (const retryBaseDelayMs of [0, -1, 1.5, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => resolveToolConcurrencyPolicy({ retryBaseDelayMs }, path))
        .toThrow(/retryBaseDelayMs must be an integer in 1\.\./)
    }
  })

  it('rejects a jitter ratio outside 0..1', () => {
    for (const retryJitterRatio of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveToolConcurrencyPolicy({ retryJitterRatio }, path))
        .toThrow(/retryJitterRatio must be a number in 0\.\.1/)
    }
    expect(resolveToolConcurrencyPolicy({ retryJitterRatio: 0 }, path).retryJitterRatio).toBe(0)
  })
})

describe('retry safety and delay', () => {
  const policyFor = (config: ToolConcurrencyConfig) => resolveToolConcurrencyPolicy(config, 'toolConcurrency')

  it('retries only the tools whose annotations are read-only or that retryTools names', () => {
    const policy = policyFor({ retryTools: ['trusted_write'] })
    // The allow-list is what makes a write retryable, and it is per tool.
    expect(allowsAutomaticRetry(policy, undefined, 'trusted_write')).toBe(true)
    expect(allowsAutomaticRetry(policy, undefined, 'other_write')).toBe(false)
    // A read-only tool qualifies on its own annotation.
    expect(allowsAutomaticRetry(policy, { readOnlyHint: true }, 'read')).toBe(true)
  })

  it('retries nothing when retryTools is empty and no annotation is read-only', () => {
    const policy = policyFor({})
    expect(allowsAutomaticRetry(policy, undefined, 'write')).toBe(false)
    expect(allowsAutomaticRetry(policy, {}, 'write')).toBe(false)
    expect(allowsAutomaticRetry(policy, { readOnlyHint: false }, 'write')).toBe(false)
    // A non-boolean hint is untrusted wire data, not a claim of safety.
    expect(allowsAutomaticRetry(policy, { readOnlyHint: 'true' } as never, 'write')).toBe(false)
    // Idempotence is the server's claim about repeats; only the deployment, or a
    // read-only annotation, makes a call retryable.
    expect(allowsAutomaticRetry(policy, { idempotentHint: true }, 'write')).toBe(false)
  })

  it('keeps the retry allow-list independent of exclusiveTools', () => {
    const policy = policyFor({ exclusiveTools: ['read'], retryTools: ['read'] })
    // Listed in both: never overlaps another call, and still retryable.
    expect(allowsConcurrentCalls(policy, undefined, 'read')).toBe(false)
    expect(allowsAutomaticRetry(policy, undefined, 'read')).toBe(true)
    // Listed as exclusive only: serial, and never retried.
    expect(allowsAutomaticRetry(policyFor({ exclusiveTools: ['write'] }), undefined, 'write')).toBe(false)
  })

  it('doubles the retry delay per attempt and spreads it symmetrically', () => {
    const policy = policyFor({ retryBaseDelayMs: 100, retryJitterRatio: 0.5 })
    // The spread is symmetric around the exact delay: the extremes are as far
    // below it as above it, so the mean delay is unchanged.
    expect(retryDelayMs(policy, 1, () => 0)).toBe(50)
    expect(retryDelayMs(policy, 1, () => 1)).toBe(150)
    expect(retryDelayMs(policy, 1, () => 0.5)).toBe(100)
    expect(retryDelayMs(policy, 3, () => 0.5)).toBe(400)
  })

  it('makes every delay exact when the jitter ratio is zero', () => {
    const policy = policyFor({ retryBaseDelayMs: 25, retryJitterRatio: 0 })
    expect(retryDelayMs(policy, 1, () => 0)).toBe(25)
    expect(retryDelayMs(policy, 2, () => 0.99)).toBe(50)
  })

  it('waits out the delay, and stops when the call is canceled instead', async () => {
    const started = Date.now()
    await expect(waitBeforeRetry(5, testToolSignal)).resolves.toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(0)

    const controller = new AbortController()
    const waiting = waitBeforeRetry(60_000, controller.signal)
    controller.abort(new Error('tool call timed out'))
    await expect(waiting).resolves.toBe(false)

    controller.abort(new Error('already canceled'))
    await expect(waitBeforeRetry(60_000, controller.signal)).resolves.toBe(false)
  })
})

describe('createToolCallLimiter', () => {
  const limiterFor = (maxConcurrentCalls: number) => createToolCallLimiter(
    resolveToolConcurrencyPolicy({ maxConcurrentCalls }, 'toolConcurrency'),
  )

  it('grants a queued slot when the holder releases it', async () => {
    const limiter = limiterFor(1)
    const first = await limiter.acquire(testToolSignal)
    let granted = false
    const queued = limiter.acquire(testToolSignal).then((release) => {
      granted = true
      return release
    })

    expect(granted).toBe(false)
    first()
    const release = await queued
    expect(granted).toBe(true)
    release()
  })

  it('rejects a signal that is already aborted without consuming a slot', async () => {
    const limiter = limiterFor(1)
    const controller = new AbortController()
    const cause = new Error('canceled before dispatch')
    controller.abort(cause)

    await expect(limiter.acquire(controller.signal)).rejects.toBe(cause)
    // The rejected acquisition must not have taken the only slot.
    const release = await limiter.acquire(testToolSignal)
    release()
  })

  it('carries a non-Error abort reason as the rejection cause', async () => {
    const limiter = limiterFor(1)
    const controller = new AbortController()
    controller.abort('teardown')

    await expect(limiter.acquire(controller.signal)).rejects.toThrow('aborted before it acquired a slot')
    const release = await limiter.acquire(testToolSignal)
    release()
  })

  it('rejects a queued call whose signal aborts and leaves its slot for the next waiter', async () => {
    const limiter = limiterFor(1)
    const holder = await limiter.acquire(testToolSignal)
    const controller = new AbortController()
    const cause = new Error('aborted while queued')
    const queued = limiter.acquire(controller.signal)
    let nextGranted = false
    const next = limiter.acquire(testToolSignal).then((release) => {
      nextGranted = true
      return release
    })

    controller.abort(cause)
    await expect(queued).rejects.toBe(cause)
    expect(nextGranted).toBe(false)

    holder()
    const release = await next
    expect(nextGranted).toBe(true)
    release()
  })

  it('leaves a granted slot alone when its signal aborts afterwards', async () => {
    const limiter = limiterFor(1)
    const controller = new AbortController()
    const release = await limiter.acquire(controller.signal)
    const queued = limiter.acquire(testToolSignal)

    // The granted call owns its own cancellation from here on; the limiter must
    // not free the slot a second time.
    controller.abort(new Error('aborted after dispatch'))
    const granted = await Promise.race([queued.then(() => 'granted'), sleep(5).then(() => 'waiting')])
    expect(granted).toBe('waiting')

    release()
    ;(await queued)()
  })

  it('releases a slot once, however often the release runs', async () => {
    const limiter = limiterFor(1)
    const release = await limiter.acquire(testToolSignal)
    release()
    release()

    const second = await limiter.acquire(testToolSignal)
    let thirdGranted = false
    const third = limiter.acquire(testToolSignal).then((next) => {
      thirdGranted = true
      return next
    })
    expect(thirdGranted).toBe(false)

    second()
    ;(await third)()
  })

  it('rejects queued and later acquisitions on close while a granted slot keeps working', async () => {
    const limiter = limiterFor(1)
    const granted = await limiter.acquire(testToolSignal)
    const queued = limiter.acquire(testToolSignal)
    const reason = new Error('the connection was disposed before this call reached the server')

    limiter.close(reason)

    await expect(queued).rejects.toBe(reason)
    await expect(limiter.acquire(testToolSignal)).rejects.toBe(reason)
    // The granted call's request is already on the wire, so its slot stays its own.
    granted()
  })
})

describe('adaptive cap', () => {
  /** A limiter whose recovery window is measured on a clock the test owns. */
  function adaptiveLimiter(config: ToolConcurrencyConfig) {
    let clock = 0
    const limiter = createToolCallLimiter(
      resolveToolConcurrencyPolicy({ mode: 'adaptive', ...config }, 'toolConcurrency'),
      { now: () => clock },
    )
    return { limiter, advance: (ms: number) => { clock += ms } }
  }

  /**
   * Slots the limiter grants now, without waiting: each acquisition is raced
   * against a macrotask, so a call that has to queue is counted as not granted,
   * and the ones that queued are then canceled out of the queue.
   */
  async function grantedNow(limiter: ConcurrencyLimiter): Promise<Array<() => void>> {
    const controller = new AbortController()
    const granted: Array<() => void> = []
    const probes = Array.from({ length: 32 }, async () => {
      const release = await Promise.race([
        limiter.acquire(controller.signal),
        sleep(0).then(() => undefined),
      ])
      if (release !== undefined) granted.push(release)
    })
    await Promise.all(probes)
    controller.abort(new Error('the probe finished'))
    return granted
  }

  /** How many slots the limiter grants right now, releasing them again. */
  async function capNow(limiter: ConcurrencyLimiter): Promise<number> {
    const granted = await grantedNow(limiter)
    for (const release of granted) release()
    return granted.length
  }

  it('halves the cap per refusal to serve', async () => {
    const { limiter } = adaptiveLimiter({ maxConcurrentCalls: 8 })
    expect(await capNow(limiter)).toBe(8)

    limiter.report('overload')
    expect(await capNow(limiter)).toBe(4)

    limiter.report('overload')
    expect(await capNow(limiter)).toBe(2)
  })

  it('never revokes a granted slot when the cap drops below what is in flight', async () => {
    const { limiter } = adaptiveLimiter({ maxConcurrentCalls: 4 })
    const held = await grantedNow(limiter)
    expect(held).toHaveLength(4)

    limiter.report('overload')
    limiter.report('overload')

    // A cap of one does not cut the four calls already on the wire; it stops
    // admitting more until they release.
    expect(await grantedNow(limiter)).toHaveLength(0)
    for (const release of held) release()
    expect(await capNow(limiter)).toBe(1)
  })

  it('stops at one slot rather than giving the server no calls at all', async () => {
    const { limiter } = adaptiveLimiter({ maxConcurrentCalls: 4 })
    for (let refusal = 0; refusal < 10; refusal += 1) limiter.report('overload')

    expect(await capNow(limiter)).toBe(1)
  })

  it('adds one step per quiet window of served calls, up to the configured cap', async () => {
    const { limiter, advance } = adaptiveLimiter({ maxConcurrentCalls: 4, recoveryQuietMs: 1_000 })
    limiter.report('overload')
    limiter.report('overload')
    expect(await capNow(limiter)).toBe(1)

    // A served call inside the window recovers nothing.
    limiter.report('served')
    expect(await capNow(limiter)).toBe(1)

    advance(1_000)
    limiter.report('served')
    expect(await capNow(limiter)).toBe(2)

    // One step per window: a second served call in the same window adds nothing.
    limiter.report('served')
    expect(await capNow(limiter)).toBe(2)

    advance(1_000)
    limiter.report('served')
    expect(await capNow(limiter)).toBe(3)

    advance(1_000)
    limiter.report('served')
    expect(await capNow(limiter)).toBe(4)

    // The configured cap is the ceiling: quiet success never widens it further.
    advance(10_000)
    limiter.report('served')
    limiter.report('served')
    expect(await capNow(limiter)).toBe(4)
  })

  it('restarts the quiet window on every refusal to serve', async () => {
    const { limiter, advance } = adaptiveLimiter({ maxConcurrentCalls: 4, recoveryQuietMs: 1_000 })
    limiter.report('overload')
    expect(await capNow(limiter)).toBe(2)

    advance(900)
    limiter.report('overload')
    advance(900)
    limiter.report('served')
    // 1800ms have passed, but only 900 of them since the last refusal: no step.
    expect(await capNow(limiter)).toBe(1)

    advance(100)
    limiter.report('served')
    expect(await capNow(limiter)).toBe(2)
  })

  it('keeps the cap at maxConcurrentCalls in fixed mode, whatever it is told', async () => {
    let clock = 0
    const limiter = createToolCallLimiter(
      resolveToolConcurrencyPolicy({ mode: 'fixed', maxConcurrentCalls: 4 }, 'toolConcurrency'),
      { now: () => clock },
    )
    for (let refusal = 0; refusal < 5; refusal += 1) limiter.report('overload')
    clock += 60_000
    limiter.report('served')

    expect(await capNow(limiter)).toBe(4)
  })
})
