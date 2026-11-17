// External MCP mounting: which servers are mounted, into which scope, and when.
// The tier split is the behavior under test — the deployment-wide list connects
// once at startup and reaches every session through the scope chain, while a
// user's own rows mount into that session alone. The connector is a test double,
// so these cases assert the mounting decision without opening connections.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { McpServerStore, mountNameFor } from '@deepseek-ai/dsh-mcp-servers'
import type { EffectiveMcpServer, ExternalMcpServerRecord, StoredRegistry } from '@deepseek-ai/dsh-mcp-servers'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import {
  apply as applyExternal,
  mountAgent,
  resolveConfig,
  systemServers,
  toClientConfig,
  userServers,
} from '../src/index.ts'
import type { MountedConnection } from '../src/index.ts'

/** The tool name the real MCP client would publish for one mount. */
function toolName(mountName: string): string {
  return 'mcp__' + mountName + '__ping'
}

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

  /** Seed the system list before the plugin starts, the way a warm database would. */
  seedSystem(records: ExternalMcpServerRecord[]): void {
    this.systemRecords = [...records]
    this.revisionCount += 1
  }

  /** Seed one user's list before the plugin starts. */
  seedUser(userId: string, records: ExternalMcpServerRecord[]): void {
    this.userRecords.set(userId, [...records])
  }

  /** A durable write followed by the announcement the plugin listens for. */
  async setSystem(records: ExternalMcpServerRecord[]): Promise<void> {
    await this.writeSystem(records)
    this.publish()
  }

  /** A durable user write followed by the announcement. */
  async setUser(userId: string, records: ExternalMcpServerRecord[]): Promise<void> {
    await this.writeUser(userId, records)
    this.publish()
  }

  /** Announce a write without changing anything. */
  publish(): void {
    this.notify()
  }
}

const tenant = (id: string): Tenant => ({
  id: TenantId(id),
  name: id,
  dataRoot: '/data/' + id,
  workspaceRoot: '/workspace/' + id,
})

/** Enter the ambient (tenant, user) scope session creation runs under. */
function scoped<T>(user: string, fn: () => T): T {
  return runWithTenant(tenant('acme'), () => runWithUser(UserId(user), fn))
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * Poll until the predicate holds.
 *
 * Every mount is background work by design, so a test cannot await it
 * directly; it waits for the observable effect instead.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
  throw new Error('timed out waiting for ' + what)
}

/** Let already-queued background work run, without a target condition. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 1) })
  }
}

async function harness(
  config: Record<string, unknown> = {},
  internals: Record<string, unknown> = {},
  seed?: (store: MemoryStore) => void,
): Promise<{ ctx: Context; store: MemoryStore }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryStore)
  const store = ctx.mcpServers as MemoryStore
  seed?.(store)
  // Cordis calls a plugin with (ctx, config) only, so the non-serializable
  // connector hook is passed by invoking the plugin directly on an active context.
  applyExternal(ctx, config, internals)
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  return { ctx, store }
}

let sessionCounter = 0

/** Register one agent whose context carries its own scope, the way the loop does. */
function addAgent(ctx: Context): { agent: Agent; scope: Scope; dispose: () => void } {
  sessionCounter += 1
  const session = ctx.sessions.create(SessionId('mcp-external-agent-' + String(sessionCounter)))
  const draft = {
    id: session.id,
    options: {},
    session,
    status: 'idle',
    acceptsNextStep: false,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
  // The scope key is the agent itself, exactly as the loop scopes a real session.
  const agent = draft as unknown as Agent
  const scope = createScope(ctx, agent)
  Object.assign(draft, { ctx: scope.ctx })
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
 * through the given context — as a plugin declaring the tools service, which is
 * how the real MCP client reaches the registry from a scope. It also records
 * teardown, so a test can tell a reconcile from a fresh mount.
 */
function recorder(failFor: string[] = [], unreachableFor: string[] = []) {
  const calls: Array<{ target: Context; config: StreamableHttpConfig }> = []
  const disposed: string[] = []
  const failing = new Set(failFor)
  const hanging = new Set<string>()
  /** Servers whose connector activates anyway but publishes a refused connection, like the real client. */
  const unreachable = new Set(unreachableFor)
  /** Instance contexts of those mounts, so a test can publish the reconnect later. */
  const unreachableCtxs = new Map<string, Context>()
  const connect = (target: Context, config: StreamableHttpConfig): MountedConnection => {
    calls.push({ target, config })
    if (failing.has(config.serverName)) {
      return Object.assign(Promise.reject(new Error('cannot reach ' + config.serverName)), {
        dispose() {},
      })
    }
    const fiber = target.plugin({
      name: 'test-mcp-' + config.serverName,
      inject: ['tools'],
      apply(tools: Context) {
        if (unreachable.has(config.serverName)) {
          unreachableCtxs.set(config.serverName, tools)
          tools.emit('mcp/client-state', { serverName: config.serverName, state: 'down', error: 'ECONNREFUSED' })
          return
        }
        tools.tools.register(defineTool({
          name: toolName(config.serverName),
          description: 'ping',
          parameters: {},
          output: { schema: { type: 'string' }, render: () => [{ type: 'text' as const, text: 'pong' }] },
          async execute() { return 'pong' },
        }))
      },
    })
    const settled = hanging.has(config.serverName) ? new Promise<void>(() => {}) : fiber
    return {
      ctx: fiber.ctx,
      then: settled.then.bind(settled) as MountedConnection['then'],
      dispose: async () => {
        disposed.push(config.serverName)
        await fiber.dispose()
      },
    }
  }
  return { calls, disposed, failing, hanging, unreachableCtxs, connect }
}

/** Dispatch one step boundary. Mounting must not be waiting behind it. */
async function step(ctx: Context, agent: Agent): Promise<void> {
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
}

/** The single server a one-row registry resolves. */
function onlyServer(store: McpServerStore): EffectiveMcpServer {
  const [server] = systemServers(store)
  if (server === undefined) throw new Error('expected exactly one server')
  return server
}

/** The tool registry of one scope, read through the service store (no inject needed). */
const toolsOf = (scope: Context) => scope.get('tools')!

const callsInto = (rec: ReturnType<typeof recorder>, target: Context): StreamableHttpConfig[] =>
  rec.calls.filter(call => call.target === target).map(call => call.config)

describe('startup mounting', () => {
  it('mounts the system list once, in the plugin scope, not in a session', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([row({ serverName: 'alpha' }), row({ serverName: 'beta' })])
    })
    await until(() => rec.calls.length === 2, 'the system tier to mount')
    expect(rec.calls.every(call => call.target === ctx)).toBe(true)
    expect(rec.calls.map(call => call.config.serverName).sort())
      .toEqual([mountNameFor('system', 'alpha'), mountNameFor('system', 'beta')])
  })

  it('starts the mount during plugin activation instead of waiting for a session', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the startup connection attempt')
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('registers system tools a later session resolves through the scope chain', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the system tier to mount')
    await flush()
    const session = addAgent(ctx)
    expect(callsInto(rec, session.agent.ctx)).toHaveLength(0)
    expect(toolsOf(session.agent.ctx).get(toolName(mountNameFor('system', 'alpha')))).toBeDefined()
    session.dispose()
  })

  it('keeps one unreachable server from stopping the others', async () => {
    const rec = recorder([mountNameFor('system', 'broken')])
    await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([
        row({ serverName: 'broken', url: 'https://broken.example/rpc' }),
        row({ serverName: 'alpha' }),
      ])
    })
    await until(() => rec.calls.length === 2, 'both servers to be attempted')
    await flush()
    expect(rec.calls).toHaveLength(2)
  })

  it('publishes what each mount actually did, and forgets a row that goes away', async () => {
    const rec = recorder([mountNameFor('system', 'broken')])
    const { store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([
        row({ serverName: 'alpha' }),
        row({ serverName: 'broken', url: 'https://broken.example/rpc' }),
      ])
    })
    // A surface reads this to tell a connected server from one that refused us.
    await until(() => store.mountReport(mountNameFor('system', 'alpha'))?.state === 'mounted', 'the mounted report')
    await until(() => store.mountReport(mountNameFor('system', 'broken'))?.state === 'failed', 'the failed report')
    expect(store.mountReport(mountNameFor('system', 'broken'))?.error).toContain('cannot reach')

    await store.setSystem([row({ serverName: 'alpha' })])
    await until(() => store.mountReport(mountNameFor('system', 'broken')) === undefined, 'the stale report to clear')
    expect(store.mountReport(mountNameFor('system', 'alpha'))?.state).toBe('mounted')
  })

  it('reports a server that activates without connecting as failed, then follows it back up', async () => {
    const rec = recorder([], [mountNameFor('system', 'refused')])
    const { store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'refused', url: 'https://refused.example/rpc' })])
    })
    // Activation succeeds — failOnStartupError is false — so the connector's own
    // report is the only thing that can tell this row from a live one.
    await until(() => store.mountReport(mountNameFor('system', 'refused'))?.state === 'failed', 'the refused report')
    expect(store.mountReport(mountNameFor('system', 'refused'))?.error).toBe('ECONNREFUSED')

    rec.unreachableCtxs.get(mountNameFor('system', 'refused'))?.emit('mcp/client-state', {
      serverName: mountNameFor('system', 'refused'),
      state: 'up',
    })
    await until(() => store.mountReport(mountNameFor('system', 'refused'))?.state === 'mounted', 'the recovery report')
    expect(store.mountReport(mountNameFor('system', 'refused'))?.error).toBeUndefined()
  })

  it('caps the system tier and says so', async () => {
    const rec = recorder()
    const { ctx, store } = await harness({ maxServersPerAgent: 2 }, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' }), row({ serverName: 'beta' })])
    })
    await until(() => rec.calls.length === 2, 'the tier to mount')
    const warn = vi.spyOn(ctx.logger, 'warn')
    // The cap is applied on every reconcile, so a third row reports it here even
    // though the startup mount ran before the spy existed.
    await store.setSystem([
      row({ serverName: 'alpha' }),
      row({ serverName: 'beta' }),
      row({ serverName: 'gamma' }),
    ])
    await until(() => warn.mock.calls.length > 0, 'the cap warning')
    expect(rec.calls).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxServersPerAgent'))
  })

  it('fails loud when no registry provider is loaded', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRegistry)
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })
    expect(() => { applyExternal(ctx) }).toThrow(/requires ctx\.mcpServers/u)
  })
})

describe('per-session mounting', () => {
  it('mounts only the session user own rows, never the system tier', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([row({ serverName: 'alpha' })])
      store.seedUser('user-1', [row({ serverName: 'mine' })])
    })
    await until(() => rec.calls.length === 1, 'the system tier to mount')
    const session = scoped('user-1', () => addAgent(ctx))
    await until(() => callsInto(rec, session.agent.ctx).length > 0, 'the session to mount its own row')
    expect(callsInto(rec, session.agent.ctx).map(config => config.serverName))
      .toEqual([mountNameFor('user', 'mine', 'user-1')])
    session.dispose()
  })

  it('mounts nothing at all for a session whose user owns no servers', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the system tier to mount')
    const session = scoped('user-1', () => addAgent(ctx))
    await flush()
    expect(callsInto(rec, session.agent.ctx)).toHaveLength(0)
    session.dispose()
  })

  it('gives one user own server to that user and not to another', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedUser('user-1', [row({ serverName: 'mine' })])
    })
    const first = scoped('user-1', () => addAgent(ctx))
    await until(() => callsInto(rec, first.agent.ctx).length === 1, 'user-1 to mount its row')
    const second = scoped('user-2', () => addAgent(ctx))
    await flush()
    expect(callsInto(rec, second.agent.ctx)).toHaveLength(0)
    first.dispose()
    second.dispose()
  })
})


describe('no wait in the turn', () => {
  it('does not hold the step boundary behind a server that never answers', async () => {
    const rec = recorder()
    rec.hanging.add(mountNameFor('system', 'slow'))
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([row({ serverName: 'slow' })])
    })
    const session = scoped('user-1', () => addAgent(ctx))
    const started = Date.now()
    await step(ctx, session.agent)
    expect(Date.now() - started).toBeLessThan(1000)
    session.dispose()
  })

  it('does not mount anything on a step boundary', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (store) => {
      store.seedSystem([row({ serverName: 'alpha' })])
      store.seedUser('user-1', [row({ serverName: 'mine' })])
    })
    const session = scoped('user-1', () => addAgent(ctx))
    await flush()
    const before = rec.calls.length
    await step(ctx, session.agent)
    await step(ctx, session.agent)
    await flush()
    expect(rec.calls).toHaveLength(before)
    session.dispose()
  })
})

describe('registry writes', () => {
  it('adds a newly registered system server without waiting for a session', async () => {
    const rec = recorder()
    const { ctx, store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the initial tier to mount')
    const session = scoped('user-1', () => addAgent(ctx))
    await store.setSystem([row({ serverName: 'alpha' }), row({ serverName: 'beta' })])
    // No step is dispatched: the write alone must mount the new server, so the
    // tool is there for the next request the session assembles.
    await until(() => rec.calls.length === 2, 'the new system server to mount')
    await until(
      () => toolsOf(session.agent.ctx).get(toolName(mountNameFor('system', 'beta'))) !== undefined,
      'the new tool to resolve in a live session',
    )
    session.dispose()
  })

  it('unmounts a server that is removed from the registry', async () => {
    const rec = recorder()
    const { store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' }), row({ serverName: 'beta' })])
    })
    await until(() => rec.calls.length === 2, 'both servers to mount')
    await store.setSystem([row({ serverName: 'alpha' })])
    await until(
      () => rec.disposed.includes(mountNameFor('system', 'beta')),
      'the removed server to unmount',
    )
    expect(rec.disposed).not.toContain(mountNameFor('system', 'alpha'))
  })

  it('unmounts a server that an operator disables', async () => {
    const rec = recorder()
    const { store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the tier to mount')
    await store.setSystem([row({ serverName: 'alpha', enabled: false })])
    await until(
      () => rec.disposed.includes(mountNameFor('system', 'alpha')),
      'the disabled server to unmount',
    )
  })

  it('reconnects a server whose endpoint changed, and only that one', async () => {
    const rec = recorder()
    const { store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' }), row({ serverName: 'beta' })])
    })
    await until(() => rec.calls.length === 2, 'both servers to mount')
    await store.setSystem([
      row({ serverName: 'alpha', url: 'https://moved.acme.example/rpc' }),
      row({ serverName: 'beta' }),
    ])
    await until(() => rec.disposed.includes(mountNameFor('system', 'alpha')), 'the changed server to unmount')
    await until(() => rec.calls.length === 3, 'the changed server to remount')
    expect(rec.disposed).not.toContain(mountNameFor('system', 'beta'))
    expect(rec.calls.filter(call => call.config.serverName === mountNameFor('system', 'beta'))).toHaveLength(1)
  })

  it('leaves every mount alone when nothing changed', async () => {
    const rec = recorder()
    const { store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the tier to mount')
    await store.setSystem([row({ serverName: 'alpha' })])
    await flush()
    expect(rec.calls).toHaveLength(1)
    expect(rec.disposed).toHaveLength(0)
  })

  it('retries a server that failed once it is reachable again', async () => {
    const rec = recorder([mountNameFor('system', 'alpha')])
    const { store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the first attempt')
    await flush()
    rec.failing.clear()
    await store.setSystem([row({ serverName: 'alpha' })])
    await until(() => rec.calls.length === 2, 'the retry after the server recovered')
  })

  it('reconciles a user own server without touching another session', async () => {
    const rec = recorder()
    const { ctx, store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedUser('user-1', [row({ serverName: 'mine' })])
    })
    const first = scoped('user-1', () => addAgent(ctx))
    await until(() => callsInto(rec, first.agent.ctx).length === 1, 'the first session to mount')
    const second = scoped('user-2', () => addAgent(ctx))
    await flush()
    await store.setUser('user-1', [row({ serverName: 'mine' }), row({ serverName: 'extra' })])
    await until(() => callsInto(rec, first.agent.ctx).length === 2, 'the first session to pick up the new row')
    expect(callsInto(rec, second.agent.ctx)).toHaveLength(0)
    first.dispose()
    second.dispose()
  })
})

describe('lifecycle', () => {
  it('closes its mounts when the plugin is disposed', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedSystem([row({ serverName: 'alpha' })])
    })
    await until(() => rec.calls.length === 1, 'the tier to mount')
    await ctx.fiber.dispose()
    await until(
      () => rec.disposed.includes(mountNameFor('system', 'alpha')),
      'disposal to close the mount',
    )
  })

  it('stops tracking a session once it is disposed', async () => {
    const rec = recorder()
    const { ctx, store } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedUser('user-1', [row({ serverName: 'mine' })])
    })
    const session = scoped('user-1', () => addAgent(ctx))
    await until(() => callsInto(rec, session.agent.ctx).length === 1, 'the session to mount')
    agentEvents(ctx, session.agent).emit('agent/disposed', { agent: session.agent })
    await flush()
    const before = rec.calls.length
    await store.setUser('user-1', [row({ serverName: 'mine' }), row({ serverName: 'extra' })])
    await flush()
    expect(rec.calls).toHaveLength(before)
    session.dispose()
  })
})

describe('configuration', () => {
  it('resolves defaults', () => {
    expect(resolveConfig()).toEqual({ maxServersPerAgent: 16, toolCallTimeoutMs: 60_000 })
  })

  it('never lets a row fail an agent activation', () => {
    const config = resolveConfig()
    const store = { system: () => [row()] } as unknown as McpServerStore
    expect(toClientConfig(onlyServer(store), config)).toMatchObject({
      transport: 'streamable-http',
      serverName: mountNameFor('system', 'acme-tools'),
      failOnStartupError: false,
      toolCallTimeoutMs: 60_000,
    })
  })

  it('applies the configured default only to a row that sets no timeout', () => {
    const config = resolveConfig({ toolCallTimeoutMs: 1234 })
    const plain = { system: () => [row()] } as unknown as McpServerStore
    expect(toClientConfig(onlyServer(plain), config).toolCallTimeoutMs).toBe(1234)
    const explicit = { system: () => [row({ timeoutMs: 99 })] } as unknown as McpServerStore
    expect(toClientConfig(onlyServer(explicit), config).toolCallTimeoutMs).toBe(99)
  })

  it('carries a row concurrency policy through to the client', () => {
    const config = resolveConfig()
    const store = {
      system: () => [{ ...row(), toolConcurrency: { maxConcurrent: 3 } }],
    } as unknown as McpServerStore
    expect(toClientConfig(onlyServer(store), config).toolConcurrency).toEqual({ maxConcurrent: 3 })
  })

  it('gives a session nothing outside a user scope', () => {
    const store = { user: () => [row()] } as unknown as McpServerStore
    expect(userServers(store, undefined)).toEqual([])
  })
})

describe('mountAgent', () => {
  it('mounts a session own rows into that session scope', async () => {
    const rec = recorder()
    const { ctx } = await harness({}, { connect: rec.connect }, (seed) => {
      seed.seedUser('user-1', [row({ serverName: 'mine' })])
    })
    const session = scoped('user-1', () => addAgent(ctx))
    const state = await scoped('user-1', () => mountAgent(
      ctx, session.agent, ctx.mcpServers, resolveConfig(), { connect: rec.connect },
    ))
    expect(state.userId).toBe('user-1')
    expect([...state.book.mounted.keys()]).toEqual([mountNameFor('user', 'mine', 'user-1')])
    session.dispose()
  })
})
