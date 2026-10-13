/**
 * What `toolConcurrency.exclusiveTools` does to real dispatch.
 *
 * `mcp-client` classifies a listed tool as exclusive; the agent loop turns that
 * classification into a barrier. This suite mounts the real loop over real MCP
 * servers (in-memory transports) so both halves are measured as the overlap the
 * servers themselves observed, and so the barrier's scope �?one assistant step,
 * every server �?is pinned by evidence rather than assumed:
 * `packages/core/agent-loop/src/tool-calls.ts:88` takes the classification of
 * the next call, `:89` makes an exclusive call a group of one, `:203` stops
 * filling a parallel pool at a call that reclassifies exclusive, `:220` drains
 * in-flight work before the group returns, and `:245` consumes only what
 * started, so the exclusive call runs alone with respect to the whole step.
 */

import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolCallLimiter, resolveToolConcurrencyPolicy } from '@deepseek-ai/dsh-mcp-client/src/concurrency.ts'
import { syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ToolConcurrencyConfig } from '@deepseek-ai/dsh-mcp-client'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Hold every fixture call open this long, so overlap is observable. */
const HOLD_MS = 40

/**
 * One assistant step's observed call load, shared by every server that step
 * dispatched to: `peak` is therefore the overlap ACROSS servers, which is what
 * distinguishes a step-wide barrier from a per-server one.
 */
interface Ledger {
  inFlight: number
  peak: number
  order: string[]
}

function newLedger(): Ledger {
  return { inFlight: 0, peak: 0, order: [] }
}

function sleep(ms: number): Promise<void> {
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

/** One assistant step asking for several tool calls at once. */
function multiCall(calls: { id: string; name: string; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: CallId(call.id), name: call.name, arguments: JSON.stringify(call.args) } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/**
 * Mount the real loop over the standard prerequisite services, with `adapter`
 * scripted as the model.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** One fixture server's teardown. */
interface Fixture {
  close(): Promise<void>
}

/**
 * Start a real MCP server advertising `read` (annotated read-only) and `write`
 * (no annotations), bridge it onto `ctx` under `serverName`, and record every
 * call it serves in the shared `ledger`.
 *
 * @param ctx - mounted loop context owning the tool registry.
 * @param ledger - step-wide call load shared with every other fixture.
 * @param serverName - namespace for this server's public tool names.
 * @param concurrency - raw `toolConcurrency` config for this server.
 * @returns the fixture's teardown handle.
 */
async function startServer(
  ctx: Context,
  ledger: Ledger,
  serverName: string,
  concurrency?: ToolConcurrencyConfig,
): Promise<Fixture> {
  const server = new McpServer({ name: `exclusive-tools-${serverName}`, version: '1.0.0' })
  const shape = { tag: z.string() }
  const respond = async (tool: string, tag: string) => {
    ledger.inFlight += 1
    ledger.peak = Math.max(ledger.peak, ledger.inFlight)
    ledger.order.push(`${tool}:${tag}`)
    await sleep(HOLD_MS)
    ledger.inFlight -= 1
    return { content: [{ type: 'text' as const, text: `${tool}:${tag}` }] }
  }
  server.registerTool('read', {
    description: 'Reads a tag.',
    inputSchema: shape,
    annotations: { readOnlyHint: true },
  }, async (args) => { return respond('read', args.tag) })
  server.registerTool('write', {
    description: 'Writes a tag.',
    inputSchema: shape,
  }, async (args) => { return respond('write', args.tag) })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'exclusive-tools-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const policy = resolveToolConcurrencyPolicy(concurrency, `mcp-client(${serverName}): toolConcurrency`)
  await syncTools(client, ctx, {
    registrationFailure: 'contain',
    serverName,
    toolCallTimeoutMs: 60_000,
    concurrency: policy,
    limiter: createToolCallLimiter(policy),
  } satisfies ToolBridgeOptions, new Map())

  return {
    async close() {
      await client.close()
      await server.close()
    },
  }
}

/** Resolve when `agent` returns to idle, so a scripted step has fully settled. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** One scripted step: `agent` runs the model's calls and settles back to idle. */
async function runStep(ctx: Context, agent: Agent): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await idle
}

/** Every tool result the step logged, as `<text>:<isError>`. */
function results(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((event): event is Extract<SessionEvent, { type: 'tool/result' }> => event.type === 'tool/result')
    .map((event) => {
      const block = event.data.message.content[0]
      const text = block.content.filter(part => part.type === 'text').map(part => part.text).join('')
      return `${text}:${block.isError}`
    })
}

/** A step of `count` calls to `tool` on `serverName`, tagged in submission order. */
function stepOf(serverName: string, tool: string, count: number): StreamChunk[] {
  return multiCall(
    Array.from({ length: count }, (_unused, index) => ({
      id: `${tool}-${index}`,
      name: `mcp__${serverName}__${tool}`,
      args: { tag: `t${index}` },
    })),
  )
}

describe('exclusiveTools: a listed tool runs alone', () => {
  it('serializes five listed calls under a cap of 20, in submission order, all succeeding', async () => {
    const ledger = newLedger()
    const adapter = new MockAdapter([stepOf('srv', 'write', 5), textResponse('done')])
    const ctx = await harness(adapter)
    // `policy: 'parallel'` would otherwise overlap every write: the list is the
    // only thing making these calls exclusive.
    const fixture = await startServer(ctx, ledger, 'srv', { policy: 'parallel', maxConcurrentCalls: 20, exclusiveTools: ['write'] })
    try {
      const agent = ctx.agentLoop.create(SessionId('listed'), { provider: 'mock', model: 'mock' })
      await runStep(ctx, agent)

      expect(ledger.peak).toBe(1)
      expect(ledger.order).toEqual(['write:t0', 'write:t1', 'write:t2', 'write:t3', 'write:t4'])
      expect(results(agent)).toEqual([
        'write:t0:false',
        'write:t1:false',
        'write:t2:false',
        'write:t3:false',
        'write:t4:false',
      ])
    } finally {
      await fixture.close()
    }
  })

  it('leaves the same server\'s unlisted tools overlapping', async () => {
    const ledger = newLedger()
    const adapter = new MockAdapter([stepOf('srv', 'read', 4), textResponse('done')])
    const ctx = await harness(adapter)
    const fixture = await startServer(ctx, ledger, 'srv', { policy: 'parallel', maxConcurrentCalls: 20, exclusiveTools: ['write'] })
    try {
      const agent = ctx.agentLoop.create(SessionId('unlisted'), { provider: 'mock', model: 'mock' })
      await runStep(ctx, agent)

      expect(ledger.peak).toBe(4)
      expect([...ledger.order].sort()).toEqual(['read:t0', 'read:t1', 'read:t2', 'read:t3'])
    } finally {
      await fixture.close()
    }
  })

  it('wins over an annotation that claims the listed tool is read-only', async () => {
    const ledger = newLedger()
    const adapter = new MockAdapter([stepOf('srv', 'read', 4), textResponse('done')])
    const ctx = await harness(adapter)
    // A third-party server that advertises `readOnlyHint` on a mutating tool is
    // the case the deployment cannot fix at the server.
    const fixture = await startServer(ctx, ledger, 'srv', { policy: 'parallel', maxConcurrentCalls: 20, exclusiveTools: ['read'] })
    try {
      const agent = ctx.agentLoop.create(SessionId('annotated'), { provider: 'mock', model: 'mock' })
      await runStep(ctx, agent)

      expect(ledger.peak).toBe(1)
      expect(ledger.order).toEqual(['read:t0', 'read:t1', 'read:t2', 'read:t3'])
    } finally {
      await fixture.close()
    }
  })

  it('holds the barrier across servers: a listed call blocks another server\'s calls', async () => {
    const ledger = newLedger()
    const step = multiCall([
      { id: 'r0', name: 'mcp__a__read', args: { tag: 't0' } },
      { id: 'w0', name: 'mcp__b__write', args: { tag: 'w0' } },
      { id: 'r1', name: 'mcp__a__read', args: { tag: 't1' } },
    ])
    const adapter = new MockAdapter([step, textResponse('done')])
    const ctx = await harness(adapter)
    const serverA = await startServer(ctx, ledger, 'a', { policy: 'parallel', maxConcurrentCalls: 20 })
    const serverB = await startServer(ctx, ledger, 'b', { policy: 'parallel', maxConcurrentCalls: 20, exclusiveTools: ['write'] })
    try {
      const agent = ctx.agentLoop.create(SessionId('cross-server'), { provider: 'mock', model: 'mock' })
      await runStep(ctx, agent)

      // Server A's read is parallel-classified and would overlap its sibling,
      // so a peak of 1 can only come from B's listed call owning the step.
      expect(ledger.peak).toBe(1)
      expect(ledger.order).toEqual(['read:t0', 'write:w0', 'read:t1'])
      expect(results(agent)).toEqual(['read:t0:false', 'write:w0:false', 'read:t1:false'])
    } finally {
      await serverA.close()
      await serverB.close()
    }
  })

  it('overlaps the same three cross-server calls when the list does not name the tool', async () => {
    const ledger = newLedger()
    const step = multiCall([
      { id: 'r0', name: 'mcp__a__read', args: { tag: 't0' } },
      { id: 'w0', name: 'mcp__b__write', args: { tag: 'w0' } },
      { id: 'r1', name: 'mcp__a__read', args: { tag: 't1' } },
    ])
    const adapter = new MockAdapter([step, textResponse('done')])
    const ctx = await harness(adapter)
    const serverA = await startServer(ctx, ledger, 'a', { policy: 'parallel', maxConcurrentCalls: 20 })
    const serverB = await startServer(ctx, ledger, 'b', { policy: 'parallel', maxConcurrentCalls: 20 })
    try {
      const agent = ctx.agentLoop.create(SessionId('cross-server-parallel'), { provider: 'mock', model: 'mock' })
      await runStep(ctx, agent)

      expect(ledger.peak).toBe(3)
      expect([...ledger.order].sort()).toEqual(['read:t0', 'read:t1', 'write:w0'])
    } finally {
      await serverA.close()
      await serverB.close()
    }
  })

  it('overlaps every tool of an annotation-less server under policy parallel', async () => {
    const ledger = newLedger()
    const adapter = new MockAdapter([stepOf('srv', 'write', 4), textResponse('done')])
    const ctx = await harness(adapter)
    // The third-party main path: a server that declares nothing, judged parallel
    // by deployment configuration rather than by its own annotations.
    const fixture = await startServer(ctx, ledger, 'srv', { policy: 'parallel', maxConcurrentCalls: 20 })
    try {
      const agent = ctx.agentLoop.create(SessionId('third-party'), { provider: 'mock', model: 'mock' })
      await runStep(ctx, agent)

      expect(ledger.peak).toBe(4)
      expect(results(agent)).toEqual([
        'write:t0:false',
        'write:t1:false',
        'write:t2:false',
        'write:t3:false',
      ])
    } finally {
      await fixture.close()
    }
  })
})
