// External MCP mounting: which servers a session is given, under which
// namespace, and into which scope. The connector is a test double, so these
// cases assert the mounting decision itself without opening connections.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import { McpServerStore, mountNameFor } from '@deepseek-ai/dsh-mcp-servers'
import type { ExternalMcpServerRecord, StoredRegistry } from '@deepseek-ai/dsh-mcp-servers'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { apply as applyExternal, awaitMount, mountAgent, resolveConfig } from '../src/index.ts'
import type { MountedConnection } from '../src/index.ts'

/** A registry row an operator or a user would have stored. */
function row(overrides: Partial<ExternalMcpServerRecord> = {}): ExternalMcpServerRecord {
  return {
    serverName: 'acme-tools',
    url: 'https://mcp.acme.example/rpc',
    headers: {},
    enabled: true,
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  }
}

/** The registry over two arrays: the mounting code is what is under test. */
class MemoryStore extends McpServerStore {
  systemRecords: ExternalMcpServerRecord[] = []
  userRecords = new Map<string, ExternalMcpServerRecord[]>()
  revisionCount = 0

  override revision(): number {
    return this.revisionCount
  }

  protected override snapshotSystem(): readonly ExternalMcpServerRecord[] {
    return this.systemRecords
  }

  protected override snapshotUser(userId: string): readonly ExternalMcpServerRecord[] {
    return this.userRecords.get(userId) ?? []
  }

  protected override async loadSystem(): Promise<StoredRegistry> {
    return { records: this.systemRecords, revision: this.revisionCount }
  }

  protected override async loadUser(userId: string): Promise<StoredRegistry> {
    return { records: this.userRecords.get(userId) ?? [], revision: 0 }
  }

  protected override async writeSystem(records: readonly ExternalMcpServerRecord[]): Promise<number> {
    this.systemRecords = [...records]
    this.revisionCount += 1
    return this.revisionCount
  }

  protected override async writeUser(userId: string, records: readonly ExternalMcpServerRecord[]): Promise<void> {
    this.userRecords.set(userId, [...records])
  }
}

const tenant = (id: string): Tenant => ({ id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot: `/workspace/${id}` })

/** Enter the ambient (tenant, user) scope session creation runs under. */
function scoped<T>(user: string, fn: () => T): T {
  return runWithTenant(tenant('acme'), () => runWithUser(UserId(user), fn))
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function harness(
  config: Record<string, unknown> = {},
  internals: Record<string, unknown> = {},
): Promise<{ ctx: Context; store: MemoryStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryStore)
  // Cordis calls a plugin with `(ctx, config)` only, so the non-serializable
  // connector hook is passed by invoking the plugin the way its own package's
  // tests do: directly, on an already-active context.
  applyExternal(ctx, config, internals)
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  return { ctx, store: ctx.mcpServers as MemoryStore }
}

let sessionCounter = 0

/** Register one agent whose context carries its own scope, the way the loop does. */
function addAgent(ctx: Context): { agent: Agent; scope: Scope; dispose: () => void } {
  sessionCounter += 1
  const session = ctx.sessions.create(SessionId(`mcp-external-agent-${String(sessionCounter)}`))
  const scope = createScope(ctx, { externalAgent: sessionCounter })
  const agent = {
    id: session.id,
    options: {},
    session,
    status: 'idle',
    acceptsNextStep: false,
    ctx: scope.ctx,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  const unregister = ctx.agents.register(agent)
  return {
    agent,
    scope,
    dispose: () => {
      unregister()
      void scope.rawDispose()
    },
  }
}

/**
 * A connector that records what it was asked to mount and registers a tool
 * through the given context — as a plugin declaring `tools`, which is how the
 * real MCP client reaches the registry from an agent scope. It also records
 * teardown, so a test can tell a reconcile from a fresh mount.
 */
function recorder(failFor: string[] = []) {
  const calls: Array<{ target: Context; config: StreamableHttpConfig }> = []
  const disposed: string[] = []
  const connect = (target: Context, config: StreamableHttpConfig): MountedConnection => {
    calls.push({ target, config })
    if (failFor.includes(config.serverName)) {
      return Object.assign(Promise.reject(new Error(`cannot reach ${config.serverName}`)), {
        dispose() {},
      })
    }
    const fiber = target.plugin({
      name: `test-mcp-${config.serverName}`,
      inject: ['tools'],
      apply(tools: Context) {
        tools.tools.register(defineTool({
          name: `mcp__${config.serverName}__ping`,
          description: 'ping',
          parameters: {},
          output: { schema: { type: 'string' }, render: () => [{ type: 'text' as const, text: 'pong' }] },
          async execute() { return 'pong' },
        }))
      },
    })
    return {
      // Thenable over the fiber's own activation, so `await connection` still
      // means "the mount settled".
      then: fiber.then.bind(fiber) as MountedConnection['then'],
      dispose: async () => {
        disposed.push(config.serverName)
        await fiber.dispose()
      },
    }
  }
  return { calls, disposed, connect }
}

/** Dispatch one step boundary, which is where a session's mounts reconcile. */
async function step(ctx: Context, agent: Agent): Promise<void> {
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
}

describe('mountAgent', () => {
  it('mounts the system registry plus the session user’s own rows', async () => {
    const { ctx, store } = await harness()
    store.systemRecords = [row({ serverName: 'icac-bill', headers: { Authorization: 'Bearer s' }, timeoutMs: 1_000 }), row({ serverName: 'off', enabled: false })]
    store.userRecords.set('user-1', [row({ serverName: 'mine' })])
    const { calls, connect } = recorder()
    const mounted = addAgent(ctx)
    cleanups.push(async () => { mounted.dispose() })

    await scoped('user-1', () => mountAgent(ctx, mounted.agent, store, resolveConfig(), { connect }))

    expect(calls.map(call => call.config.serverName)).toEqual(['icac-bill', mountNameFor('user', 'mine', 'user-1')])
    expect(calls[0]!.config).toMatchObject({
      transport: 'streamable-http',
      url: 'https://mcp.acme.example/rpc',
      headers: { Authorization: 'Bearer s' },
      toolCallTimeoutMs: 1_000,
      failOnStartupError: false,
    })
    expect(calls[0]!.target).toBe(mounted.agent.ctx)
  })

  it('applies the configured default timeout to a row that sets none', async () => {
    const { ctx, store } = await harness()
    store.systemRecords = [row()]
    const { calls, connect } = recorder()
    const mounted = addAgent(ctx)
    cleanups.push(async () => { mounted.dispose() })

    await scoped('user-1', () => mountAgent(ctx, mounted.agent, store, resolveConfig({ toolCallTimeoutMs: 7_000 }), { connect }))
    expect(calls[0]!.config.toolCallTimeoutMs).toBe(7_000)
  })

  it('carries a row’s concurrency policy through to the client', async () => {
    const { ctx, store } = await harness()
    store.systemRecords = [row({ toolConcurrency: { policy: 'exclusive', maxConcurrentCalls: 2 } })]
    const { calls, connect } = recorder()
    const mounted = addAgent(ctx)
    cleanups.push(async () => { mounted.dispose() })

    await scoped('user-1', () => mountAgent(ctx, mounted.agent, store, resolveConfig(), { connect }))
    expect(calls[0]!.config.toolConcurrency).toEqual({ policy: 'exclusive', maxConcurrentCalls: 2 })
  })

  it('mounts only the system rows outside a user scope', async () => {
    const { ctx, store } = await harness()
    store.systemRecords = [row({ serverName: 'icac-bill' })]
    store.userRecords.set('user-1', [row({ serverName: 'mine' })])
    const { calls, connect } = recorder()
    const mounted = addAgent(ctx)
    cleanups.push(async () => { mounted.dispose() })

    await mountAgent(ctx, mounted.agent, store, resolveConfig(), { connect })
    expect(calls.map(call => call.config.serverName)).toEqual(['icac-bill'])
  })

  it('keeps one unreachable server from stopping the others', async () => {
    const { ctx, store } = await harness()
    store.systemRecords = [row({ serverName: 'broken' }), row({ serverName: 'working' })]
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const { calls, connect } = recorder(['broken'])
    const mounted = addAgent(ctx)
    cleanups.push(async () => { mounted.dispose() })

    const state = await scoped('user-1', () => mountAgent(ctx, mounted.agent, store, resolveConfig(), { connect }))
    expect(calls.map(call => call.config.serverName)).toEqual(['broken', 'working'])
    // The failed mount is not recorded, so a later reconcile tries it again.
    expect([...state.mounted.keys()]).toEqual(['working'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be mounted'))
  })

  it('caps the servers mounted into one session and says so', async () => {
    const { ctx, store } = await harness()
    store.systemRecords = [row({ serverName: 'first' }), row({ serverName: 'second' })]
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const { calls, connect } = recorder()
    const mounted = addAgent(ctx)
    cleanups.push(async () => { mounted.dispose() })

    await scoped('user-1', () => mountAgent(ctx, mounted.agent, store, resolveConfig({ maxServersPerAgent: 1 }), { connect }))
    expect(calls.map(call => call.config.serverName)).toEqual(['first'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxServersPerAgent'))
  })
})

describe('apply', () => {
  it('mounts into the created agent’s own scope, invisible to another session', async () => {
    const { calls, connect } = recorder()
    const { ctx, store } = await harness({}, { connect })
    store.systemRecords = [row({ serverName: 'icac-bill' })]
    const first = scoped('user-1', () => addAgent(ctx))
    const second = scoped('user-1', () => addAgent(ctx))
    cleanups.push(async () => {
      first.dispose()
      second.dispose()
    })

    await vi.waitFor(() => {
      expect(calls).toHaveLength(2)
    })
    const firstScope = scopeOf(first.agent.ctx)!
    const secondScope = scopeOf(second.agent.ctx)!
    expect(ctx.tools.get('mcp__icac-bill__ping', firstScope)).toBeDefined()
    expect(ctx.tools.get('mcp__icac-bill__ping', secondScope)).toBeDefined()
    // Neither agent's registration is context-global, so nothing leaks to a
    // session that never mounted it.
    expect(ctx.tools.get('mcp__icac-bill__ping')).toBeUndefined()
    expect(calls[0]!.target).toBe(first.agent.ctx)
    expect(calls[1]!.target).toBe(second.agent.ctx)
  })

  it('gives one user’s own server to that user and not to another', async () => {
    const { calls, connect } = recorder()
    const { ctx, store } = await harness({}, { connect })
    store.userRecords.set('user-1', [row({ serverName: 'mine' })])
    const mine = scoped('user-1', () => addAgent(ctx))
    const theirs = scoped('user-2', () => addAgent(ctx))
    cleanups.push(async () => {
      mine.dispose()
      theirs.dispose()
    })

    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]!.config.serverName).toBe(mountNameFor('user', 'mine', 'user-1'))
    expect(ctx.tools.get(`mcp__${mountNameFor('user', 'mine', 'user-1')}__ping`, scopeOf(mine.agent.ctx))).toBeDefined()
    expect(ctx.tools.get(`mcp__${mountNameFor('user', 'mine', 'user-1')}__ping`, scopeOf(theirs.agent.ctx))).toBeUndefined()
  })

  it('picks up a registry change on the next session', async () => {
    const { calls, connect } = recorder()
    const { ctx, store } = await harness({}, { connect })
    store.systemRecords = [row({ serverName: 'before' })]
    const first = scoped('user-1', () => addAgent(ctx))
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })

    store.systemRecords = [row({ serverName: 'after' })]
    const second = scoped('user-1', () => addAgent(ctx))
    cleanups.push(async () => {
      first.dispose()
      second.dispose()
    })
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2)
    })
    expect(calls.map(call => call.config.serverName)).toEqual(['before', 'after'])
  })
})

describe('live reconcile', () => {
  /** One session, one mounted server, ready for a registry write. */
  async function live(): Promise<{
    ctx: Context
    store: MemoryStore
    calls: Array<{ target: Context; config: StreamableHttpConfig }>
    disposed: string[]
    agent: Agent
    scope: ScopeKey
  }> {
    const { calls, disposed, connect } = recorder()
    const { ctx, store } = await harness({ firstStepWaitMs: 50 }, { connect })
    await store.upsertSystem({ serverName: 'acme-tools', url: 'https://mcp.acme.example/rpc', enabled: true })
    const mounted = scoped('user-1', () => addAgent(ctx))
    cleanups.push(async () => { mounted.dispose() })
    // The first step waits for the initial mount, exactly like a real turn.
    await step(ctx, mounted.agent)
    return { ctx, store, calls, disposed, agent: mounted.agent, scope: scopeOf(mounted.agent.ctx)! }
  }

  it('adds a newly registered server to a session that is already running', async () => {
    const { ctx, store, calls, agent, scope } = await live()
    expect(calls.map(call => call.config.serverName)).toEqual(['acme-tools'])

    await store.upsertSystem({ serverName: 'fresh', url: 'https://mcp.fresh.example/rpc', enabled: true })
    await step(ctx, agent)

    expect(calls.map(call => call.config.serverName)).toEqual(['acme-tools', 'fresh'])
    expect(ctx.tools.get('mcp__fresh__ping', scope)).toBeDefined()
    // The point of reconciling at the step boundary: the next assembled request
    // already carries the new tool.
    const assembly = await ctx.systemPrompt.assemble({ scope })
    expect(assembly.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['mcp__fresh__ping']))
    // The server that was already there was not disturbed.
    expect(ctx.tools.get('mcp__acme-tools__ping', scope)).toBeDefined()
  })

  it('unmounts a server that is removed from the registry', async () => {
    const { ctx, store, disposed, agent, scope } = await live()

    await store.removeSystem('acme-tools')
    await step(ctx, agent)

    expect(disposed).toEqual(['acme-tools'])
    expect(ctx.tools.get('mcp__acme-tools__ping', scope)).toBeUndefined()
  })

  it('unmounts a server that an operator disables', async () => {
    const { ctx, store, disposed, agent, scope } = await live()

    await store.upsertSystem({ serverName: 'acme-tools', url: 'https://mcp.acme.example/rpc', enabled: false })
    await step(ctx, agent)

    expect(disposed).toEqual(['acme-tools'])
    expect(ctx.tools.get('mcp__acme-tools__ping', scope)).toBeUndefined()
  })

  it('reconnects a server whose endpoint changed, and only that one', async () => {
    const { ctx, store, calls, disposed, agent, scope } = await live()
    await store.upsertSystem({ serverName: 'other', url: 'https://mcp.other.example/rpc', enabled: true })
    await step(ctx, agent)
    const before = calls.length

    await store.upsertSystem({ serverName: 'acme-tools', url: 'https://moved.acme.example/rpc', enabled: true })
    await step(ctx, agent)

    expect(disposed).toEqual(['acme-tools'])
    expect(calls).toHaveLength(before + 1)
    expect(calls.at(-1)!.config).toMatchObject({ serverName: 'acme-tools', url: 'https://moved.acme.example/rpc' })
    // The untouched server kept its original mount.
    expect(calls.filter(call => call.config.serverName === 'other')).toHaveLength(1)
    expect(ctx.tools.get('mcp__acme-tools__ping', scope)).toBeDefined()
  })

  it('does nothing on a step with no registry write behind it', async () => {
    const { ctx, calls, agent } = await live()
    const before = calls.length
    await step(ctx, agent)
    await step(ctx, agent)
    expect(calls).toHaveLength(before)
  })

  it('keeps a failed remount from breaking the session', async () => {
    const { calls, disposed, connect } = recorder(['flaky'])
    const { ctx, store } = await harness({ firstStepWaitMs: 50 }, { connect })
    store.systemRecords = [row({ serverName: 'steady' })]
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const mounted = scoped('user-1', () => addAgent(ctx))
    cleanups.push(async () => { mounted.dispose() })
    await step(ctx, mounted.agent)
    const scope = scopeOf(mounted.agent.ctx)!

    await store.upsertSystem({ serverName: 'flaky', url: 'https://mcp.flaky.example/rpc', enabled: true })
    await step(ctx, mounted.agent)

    expect(calls.map(call => call.config.serverName)).toEqual(['steady', 'flaky'])
    expect(disposed).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be mounted'))
    expect(ctx.tools.get('mcp__steady__ping', scope)).toBeDefined()
    expect(ctx.tools.get('mcp__flaky__ping', scope)).toBeUndefined()
  })

  it('reconciles a user’s own server without touching another session', async () => {
    const { calls, connect } = recorder()
    const { ctx, store } = await harness({ firstStepWaitMs: 50 }, { connect })
    const mine = scoped('user-1', () => addAgent(ctx))
    const theirs = scoped('user-2', () => addAgent(ctx))
    cleanups.push(async () => {
      mine.dispose()
      theirs.dispose()
    })
    await step(ctx, mine.agent)
    await step(ctx, theirs.agent)
    expect(calls).toHaveLength(0)

    await store.upsertUser('user-1', { serverName: 'mine', url: 'https://mcp.mine.example/rpc', enabled: true })
    await step(ctx, mine.agent)
    await step(ctx, theirs.agent)

    expect(calls.map(call => call.config.serverName)).toEqual([mountNameFor('user', 'mine', 'user-1')])
    expect(calls[0]!.target).toBe(mine.agent.ctx)
    expect(ctx.tools.get(`mcp__${mountNameFor('user', 'mine', 'user-1')}__ping`, scopeOf(theirs.agent.ctx))).toBeUndefined()
  })

  it('stops tracking a session once it is disposed', async () => {
    const { ctx, store, calls, agent } = await live()
    agentEvents(ctx, agent).emit('agent/disposed', { agent })
    const before = calls.length

    await store.upsertSystem({ serverName: 'after-dispose', url: 'https://mcp.after.example/rpc', enabled: true })
    await step(ctx, agent)

    expect(calls).toHaveLength(before)
  })
})

describe('awaitMount', () => {
  it('returns as soon as the mount settles', async () => {
    let settled = false
    await awaitMount(Promise.resolve().then(() => {
      settled = true
    }), 5_000)
    expect(settled).toBe(true)
  })

  it('gives up after the budget instead of stalling the step', async () => {
    const started = Date.now()
    await awaitMount(new Promise<void>(() => {}), 10)
    expect(Date.now() - started).toBeGreaterThanOrEqual(9)
  })

  it('does not leave the budget timer armed', async () => {
    vi.useFakeTimers()
    try {
      await awaitMount(Promise.resolve(), 60_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
