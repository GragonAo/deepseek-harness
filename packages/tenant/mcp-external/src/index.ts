/**
 * External MCP server mounting, split into two tiers so that a conversation
 * never pays for a connection it does not already have.
 *
 * - The deployment-wide `system` list is mounted **once, at plugin startup**
 *   into the scope this plugin is applied to. Tool registrations resolve
 *   through the scope chain (nearest scope first), so every session sees those
 *   tools without a per-session mount, and a session that starts while a server
 *   is still connecting simply begins without that tool.
 * - A user's own rows are mounted into that agent's scope on `agent/created`,
 *   because the ambient user exists only while the agent is created and the
 *   user dimension must narrow what is visible. They mount under user-scoped
 *   names, so they can never collide with a system row.
 *
 * Nothing on this path waits. Startup kicks the system mount off in the
 * background, a session kicks its own mount off when it is created, and a
 * registry write re-mounts immediately rather than at the next step boundary.
 *
 * One race stays open, and it is one of ordering rather than of waiting: a
 * step's tool list is assembled *before* the `agent/pre-step` waterfall runs, so
 * a client that creates a session and sends its first message within the mount's
 * first hundred milliseconds loses that message's user-tier tools and sees them
 * from its second message on. A listener cannot close that gap — by the time it
 * runs, the list is built — which is why the mount starts at session creation
 * and no step is held.
 *
 * Two properties are enforced here rather than documented as hopes:
 *
 * - Fail closed. Tool registration is a scope registration, so a server that
 *   never mounted contributes no tool — never a half-populated one.
 * - Isolation. One user's server cannot fail the session: each mount is
 *   independent, a failed connection is logged and left out, and
 *   `failOnStartupError` stays false so a broken third-party endpoint never
 *   turns into a broken agent.
 *
 * ## When a change takes effect
 *
 * Registering, editing, or removing a server is a **live** operation. The
 * registry announces every durable write and this plugin re-mounts at once, so
 * a server a user just added starts connecting immediately instead of at their
 * next prompt. The trade-off is deliberate: a tool can disappear while a turn
 * streams, which surfaces as one failed tool call rather than as a user who
 * waits for a write they already made.
 *
 * ## What a slow or dead server costs
 *
 * One background connection attempt and a warning line, on the session that
 * holds the bad row. The client keeps retrying on its own reconnect policy, so a
 * server that comes up later joins without holding up a turn, and
 * `maxServersPerAgent` bounds how many rows either tier can contribute to one
 * session's tool list. No step waits for any of it.
 *
 * @module @deepseek-ai/dsh-mcp-external
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { effectiveServers } from '@deepseek-ai/dsh-mcp-servers'
import type { EffectiveMcpServer, McpMountReport, McpServerStore } from '@deepseek-ai/dsh-mcp-servers'
import { currentUser } from '@deepseek-ai/dsh-tenant'

/** Cordis plugin name. */
export const name = 'mcp-external'

/** The registry must exist before a session can be given any server. */
export const inject = ['mcpServers']

/** Default cap on servers one tier contributes to a session. */
const DEFAULT_MAX_SERVERS_PER_AGENT = 16

/** Default per-tool-call timeout when a registry row does not set one. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Mounting configuration. */
export interface Config {
  /**
   * Maximum servers one tier contributes to a session's tool list: the system
   * list, and separately a user's own list. A model-facing tool list is a
   * context budget, so the tail of each tier is dropped (with a warning) rather
   * than silently crowding out everything else.
   */
  maxServersPerAgent?: number
  /** Per-tool-call timeout applied to a row that does not set its own (milliseconds). */
  toolCallTimeoutMs?: number
}

/** Validate the mounting configuration. */
export const Config: Schema<Config> = z.object({
  maxServersPerAgent: z.natural().min(1).max(64).default(DEFAULT_MAX_SERVERS_PER_AGENT)
    .description('Maximum external MCP servers either tier contributes to one session.'),
  toolCallTimeoutMs: z.natural().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS)
    .description('Per-tool-call timeout applied to a registry row that does not set its own.'),
})

/** Mounting configuration with defaults resolved. */
export interface ResolvedConfig {
  /** See {@link Config.maxServersPerAgent}. */
  maxServersPerAgent: number
  /** See {@link Config.toolCallTimeoutMs}. */
  toolCallTimeoutMs: number
}

/**
 * One live mount: the plugin fiber created for a server, which can be awaited
 * (it settles once the connection is up or has failed) and disposed (which
 * unregisters that server's tools).
 */
export type MountedConnection = PromiseLike<unknown> & {
  /** Unregister the server's tools and close its connection. */
  dispose(): Promise<void> | void
  /**
   * The mount's own context, when the connector exposes one. Subscribing to it
   * is how this plugin hears a connection failure that activation itself does
   * not report (`failOnStartupError` is false, so a refused endpoint still
   * activates). Absent for a connector that publishes nothing.
   */
  readonly ctx?: Context
}

/**
 * How one server is connected. Production mounts the MCP client plugin into the
 * target scope; a test substitutes its own connector so it can assert which
 * servers went where without opening connections.
 */
export type ConnectServer = (target: Context, config: StreamableHttpConfig) => MountedConnection

/**
 * Where a mount outcome is published. Production writes it to the registry, so
 * the configuration surface can distinguish "connected" from "configured, but
 * the endpoint failed" instead of presenting both as mounted.
 */
export type MountReporter = (mountName: string, report: McpMountReport | undefined) => void

/** Non-serializable hooks for tests; production omits them. */
export interface MountInternals {
  /** Replaces the MCP client mount. */
  connect?: ConnectServer
}

/**
 * One tier's mounts, keyed by mount name, plus the serialization that keeps two
 * reconciles of the same tier from interleaving.
 */
export interface MountBook {
  /** Live mounts by mount name, with the fingerprint each was created from. */
  readonly mounted: Map<string, { fingerprint: string; connection: MountedConnection }>
  /**
   * Mount names this tier published an outcome for, mounted or failed. A failed
   * row leaves no live mount, so this is what lets a later reconcile forget the
   * name once its row goes away.
   */
  readonly reported: Set<string>
  /** The outcome last published per mount name, so a connector's own report wins. */
  readonly outcomes: Map<string, McpMountReport>
  /** Settles when the last queued reconcile has finished. */
  queue: Promise<void>
}

/**
 * What the plugin remembers about one live session: who it is for and which of
 * that user's own servers it has mounted.
 */
export interface AgentState {
  /** The session these mounts belong to. */
  readonly agent: Agent
  /** The session's user, captured where the ambient scope was still in reach. */
  readonly userId: string | undefined
  /** The mounts this session holds. */
  readonly book: MountBook
}

/**
 * Resolve configuration defaults.
 * @param config - validated configuration, possibly partial.
 * @returns the same configuration with every default filled in.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    maxServersPerAgent: config.maxServersPerAgent ?? DEFAULT_MAX_SERVERS_PER_AGENT,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
  }
}

/**
 * Map one registry row onto an MCP client configuration.
 *
 * `failOnStartupError` is always false: a third-party endpoint an operator or a
 * user typed must never be able to reject an agent's activation.
 * @param server - effective row, carrying the name it mounts under.
 * @param config - resolved mounting configuration.
 * @returns the client configuration for that row.
 */
export function toClientConfig(server: EffectiveMcpServer, config: ResolvedConfig): StreamableHttpConfig {
  const client: StreamableHttpConfig = {
    transport: 'streamable-http',
    serverName: server.mountName,
    url: server.url,
    headers: server.headers,
    toolCallTimeoutMs: server.timeoutMs ?? config.toolCallTimeoutMs,
    failOnStartupError: false,
  }
  if (server.toolConcurrency !== undefined) client.toolConcurrency = server.toolConcurrency
  return client
}

/**
 * The deployment-wide servers, mounted once at startup and shared by every
 * session through the scope chain.
 * @param store - the registry.
 * @returns the enabled system rows, each carrying the name it mounts under.
 */
export function systemServers(store: McpServerStore): EffectiveMcpServer[] {
  return effectiveServers(store.system(), [], '')
}

/**
 * The servers one session mounts for itself: exactly the rows its user owns,
 * which the system tier cannot contain and whose names cannot collide with it.
 * @param store - the registry.
 * @param userId - the session's user, or undefined outside a user scope.
 * @returns the enabled rows that user owns.
 */
export function userServers(store: McpServerStore, userId: string | undefined): EffectiveMcpServer[] {
  if (userId === undefined) return []
  return effectiveServers([], store.user(userId), userId)
}

/**
 * What a mount was created from. Two fingerprints that match mean the live mount
 * can be kept as it is; anything else means it has to be torn down and redone —
 * the client has no in-place way to move to a different endpoint or credential.
 * @param server - effective row.
 * @param config - resolved mounting configuration.
 * @returns a stable string covering everything the mount depends on.
 */
function fingerprintOf(server: EffectiveMcpServer, config: ResolvedConfig): string {
  return JSON.stringify([
    server.url,
    Object.entries(server.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    server.timeoutMs ?? config.toolCallTimeoutMs,
    server.toolConcurrency ?? null,
  ])
}

/**
 * Cap one tier and report the drop, so a full tool list never silently looks
 * complete.
 * @param ctx - the plugin context, used for logging.
 * @param available - everything the tier resolved.
 * @param config - resolved mounting configuration.
 * @returns the rows this tier contributes.
 */
function capTier(ctx: Context, available: EffectiveMcpServer[], config: ResolvedConfig): EffectiveMcpServer[] {
  if (available.length <= config.maxServersPerAgent) return available
  ctx.logger.warn(
    `mcp-external: ${String(available.length)} servers are in effect but only ${String(config.maxServersPerAgent)} are mounted `
    + '(maxServersPerAgent); raise the limit or register fewer servers',
  )
  return available.slice(0, config.maxServersPerAgent)
}

/**
 * Tear one mount down, reporting rather than propagating a failed unmount: a
 * server that refuses to close must not stop the others from being reconciled.
 * @param ctx - the plugin context, used for logging.
 * @param name - mount name being closed.
 * @param connection - the live mount.
 */
async function closeMount(ctx: Context, name: string, connection: MountedConnection): Promise<void> {
  try {
    await connection.dispose()
  } catch (error) {
    ctx.logger.warn(
      `mcp-external: server "${name}" did not unmount cleanly: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Tear a whole tier down. Used at disposal, where every mount goes at once.
 * @param ctx - the plugin context, used for logging.
 * @param book - the tier to empty.
 * @param report - where each cleared outcome is published.
 */
async function closeBook(ctx: Context, book: MountBook, report: MountReporter): Promise<void> {
  for (const [name, { connection }] of [...book.mounted]) {
    book.mounted.delete(name)
    await closeMount(ctx, name, connection)
  }
  for (const name of [...book.reported]) {
    book.reported.delete(name)
    report(name, undefined)
  }
}

/**
 * Bring one tier in line with a server list: connect what is new, reconnect what
 * changed, disconnect what is gone, and leave untouched what is still exactly
 * what it was.
 *
 * Callers do not await the connections — the returned promise settles when the
 * tier has finished reconciling, which is a background concern, not a request's.
 * @param ctx - the plugin context, used for logging.
 * @param target - the scope the mounts register into.
 * @param servers - the rows this tier should hold.
 * @param book - the tier's current mounts; updated in place.
 * @param config - resolved mounting configuration.
 * @param connect - how one server is connected.
 * @param report - where each attempt's outcome is published.
 */
async function reconcileTier(
  ctx: Context,
  target: Context,
  servers: EffectiveMcpServer[],
  book: MountBook,
  config: ResolvedConfig,
  connect: ConnectServer,
  report: MountReporter,
): Promise<void> {
  const wanted = new Map(servers.map(server => [server.mountName, server]))

  for (const [name, { connection }] of [...book.mounted]) {
    if (wanted.has(name)) continue
    book.mounted.delete(name)
    await closeMount(ctx, name, connection)
  }
  // A row that failed left no mount behind, so forgetting its outcome cannot ride
  // on the mount teardown above.
  for (const name of [...book.reported]) {
    if (wanted.has(name)) continue
    book.reported.delete(name)
    book.outcomes.delete(name)
    report(name, undefined)
  }

  await Promise.all([...wanted].map(async ([name, server]) => {
    const fingerprint = fingerprintOf(server, config)
    const current = book.mounted.get(name)
    if (current !== undefined) {
      if (current.fingerprint === fingerprint) return
      book.mounted.delete(name)
      await closeMount(ctx, name, current.connection)
    }
    /** Record one outcome here and in the registry, so the two never disagree. */
    const publish = (outcome: McpMountReport): void => {
      book.outcomes.set(name, outcome)
      book.reported.add(name)
      report(name, outcome)
    }
    book.outcomes.delete(name)
    const connection = connect(target, toClientConfig(server, config))
    book.mounted.set(name, { fingerprint, connection })
    // The connector publishes its own connection state, and it arrives during
    // activation: subscribing before the mount settles is what keeps a refused
    // endpoint from being reported as mounted once activation succeeds anyway.
    connection.ctx?.on('mcp/client-state', (event) => {
      if (event.serverName !== name) return
      publish(event.state === 'up'
        ? { state: 'mounted', at: new Date().toISOString() }
        : { state: 'failed', error: event.error ?? 'connection down', at: new Date().toISOString() })
    })
    try {
      await connection
      // Activation is the connector's word only when it published nothing.
      if (!book.outcomes.has(name)) publish({ state: 'mounted', at: new Date().toISOString() })
    } catch (error) {
      // A mount that never came up is not "mounted": leaving it recorded would
      // make every later reconcile consider it done and never retry.
      book.mounted.delete(name)
      const reason = error instanceof Error ? error.message : String(error)
      publish({ state: 'failed', error: reason, at: new Date().toISOString() })
      ctx.logger.warn(
        `mcp-external: ${server.origin} server "${server.serverName}" (${server.mountName}) could not be mounted: ` + String(error),
      )
    }
  }))
}

/**
 * A tier with nothing mounted yet.
 * @returns the empty book.
 */
function emptyBook(): MountBook {
  return { mounted: new Map(), reported: new Set(), outcomes: new Map(), queue: Promise.resolve() }
}

/**
 * Run `work` after whatever this tier is already doing, so two reconciles of the
 * same tier never interleave. The returned promise reports `work`'s own failure;
 * the queued tail swallows it so one bad reconcile cannot poison the next.
 * @param book - the tier to serialize on.
 * @param work - the reconcile to run.
 * @returns `work`'s result.
 */
function enqueue(book: MountBook, work: () => Promise<void>): Promise<void> {
  const next = book.queue.then(work, work)
  book.queue = next.catch(() => {})
  return next
}

/**
 * Mount one session's own servers into that session's scope.
 *
 * This is the only per-session mount: the system tier already lives in an outer
 * scope, so a session that has no rows of its own mounts nothing at all.
 * @param ctx - the plugin context, used for logging.
 * @param agent - the session whose scope receives the registrations.
 * @param store - the registry.
 * @param config - resolved mounting configuration.
 * @param internals - test hooks; production omits them.
 * @returns the state holding the mounts, for a caller that wants to reconcile it later.
 */
export async function mountAgent(
  ctx: Context,
  agent: Agent,
  store: McpServerStore,
  config: ResolvedConfig,
  internals: MountInternals = {},
): Promise<AgentState> {
  const user = currentUser()
  const state: AgentState = {
    agent,
    userId: user === undefined ? undefined : String(user),
    book: emptyBook(),
  }
  const connect: ConnectServer = internals.connect ?? ((target, client) => target.plugin(McpClient, client))
  // No queue to wait on here: this call owns a fresh book.
  const pass = reconcileTier(
    ctx,
    agent.ctx,
    capTier(ctx, userServers(store, state.userId), config),
    state.book,
    config,
    connect,
    (mountName, outcome) => {
      store.reportMount(mountName, outcome)
    },
  )
  // The caller still learns about a failed reconcile, so a test can observe it.
  await pass
  return state
}

/**
 * Mount the system tier at startup, mount each session's own servers as it is
 * created, and re-mount both as soon as the registry changes.
 *
 * No step waits for a mount: a conversation whose servers are slow or dead
 * starts immediately, and a server that connects later simply joins the request
 * after the next mount pass.
 * @param ctx - Cordis context carrying the registry.
 * @param config - mounting configuration.
 * @param internals - test hooks; production omits them.
 */
export function apply(ctx: Context, config: Config = {}, internals: MountInternals = {}): void {
  const resolved = resolveConfig(config)
  // `mcpServers` is a declared inject; `ctx.get` reads the service store so a
  // direct (non-Loader) construction resolves it too. Absent it, fail loud.
  const store = ctx.get('mcpServers')
  if (store === undefined) {
    throw new Error(
      '@deepseek-ai/dsh-mcp-external requires ctx.mcpServers '
      + '(load a registry provider, e.g. @deepseek-ai/dsh-mcp-servers-postgres)',
    )
  }
  const connect: ConnectServer = internals.connect ?? ((target, client) => target.plugin(McpClient, client))
  const report: MountReporter = (mountName, outcome) => {
    store.reportMount(mountName, outcome)
  }
  const system = emptyBook()
  const agents = new Map<string, AgentState>()

  /** Re-mount the system tier; never awaited by a caller. */
  const remountSystem = (): void => {
    void enqueue(system, () => reconcileTier(
      ctx, ctx, capTier(ctx, systemServers(store), resolved), system, resolved, connect, report,
    )).catch((error: unknown) => {
      ctx.logger.warn(`mcp-external: system servers could not be reconciled: ${String(error)}`)
    })
  }

  /**
   * Re-mount one session's own servers; never awaited by a caller.
   */
  const remountAgent = (state: AgentState): void => {
    const pass = enqueue(state.book, () => reconcileTier(
      ctx, state.agent.ctx, capTier(ctx, userServers(store, state.userId), resolved), state.book, resolved, connect, report,
    ))
    void pass.catch((error: unknown) => {
      ctx.logger.warn(`mcp-external: session servers could not be reconciled: ${String(error)}`)
    })
  }

  // Startup: the deployment-wide tier connects while the host is coming up, so
  // the first session already resolves those tools through the scope chain.
  ctx.effect(() => {
    remountSystem()
    return () => {
      void closeBook(ctx, system, report)
    }
  }, 'mcp-external: system mounts')

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const user = currentUser()
    const state: AgentState = {
      agent,
      userId: user === undefined ? undefined : String(user),
      book: emptyBook(),
    }
    agents.set(agent.id, state)
    remountAgent(state)
  }, { global: true }), 'mcp-external: per-session mount')

  // A registry write re-mounts at once rather than at a step boundary: a server
  // a user just added starts connecting immediately, and one they removed stops
  // being offered on the next request that reads the tool list.
  ctx.effect(() => store.subscribe(() => {
    remountSystem()
    for (const state of agents.values()) remountAgent(state)
  }), 'mcp-external: registry subscription')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    // The mounts themselves are scope registrations and go with the agent; this
    // only stops the registry from tracking a session that no longer exists.
    agents.delete(agent.id)
  }, { global: true }), 'mcp-external: session bookkeeping')
}
