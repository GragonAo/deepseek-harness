/**
 * External MCP server mounting.
 *
 * The registry service (`ctx.mcpServers`) holds two lists: the deployment-wide
 * `system` list an administrator owns, and one list per user. This plugin turns
 * them into tools: on `agent/created` it reads the effective set for the user in
 * scope and mounts one MCP client per server **in that agent's own scope**, so
 * the tools exist for that session and for nobody else. A session with no
 * user in scope mounts only the `system` list — the user dimension can only
 * narrow what is mounted, never widen it.
 *
 * Two properties matter and are enforced here rather than documented as hopes:
 *
 * - Fail closed. The mount is a scope registration, so an agent that never ran
 *   this mount sees no external MCP tool at all, not a filtered-down subset.
 * - Isolation. One user's server cannot fail the session: each mount is
 *   independent, a failed connection is logged and skipped, and
 *   `failOnStartupError` stays false so a broken third-party endpoint never
 *   turns into a broken agent.
 *
 * ## When a change takes effect
 *
 * Registering, editing, or removing a server is a **live** operation. The
 * registry announces every durable write, and the plugin marks each session it
 * is already mounting for as stale; the session's next step re-reads the
 * effective set and reconciles its mounts (connect what is new, reconnect what
 * changed, disconnect what is gone) before the step's request is assembled.
 *
 * The reconcile is deliberately anchored to the step boundary rather than to
 * the write: a tool must not disappear from underneath a tool call the model is
 * already streaming. So the guarantee is "the next step of a running session
 * sees it", which is the hot-reload a user perceives — no restart, no waiting
 * for a new session — while a step in flight keeps the tool list it started
 * with. That costs one prompt-prefix invalidation per changed step, which is the
 * price of the tools actually being there.
 *
 * The first step of a session waits (bounded by `firstStepWaitMs`) for its
 * mounts to settle, so the initial model request already carries the tools; a
 * server slower than that budget joins on a later step instead of stalling the
 * conversation. A reconcile runs under the same budget.
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
import type { EffectiveMcpServer, McpServerStore } from '@deepseek-ai/dsh-mcp-servers'
import { currentUser } from '@deepseek-ai/dsh-tenant'

/** Cordis plugin name. */
export const name = 'mcp-external'

/** The registry must exist before a session can be given any server. */
export const inject = ['mcpServers']

/** Default bound on how long a session's first step waits for its mounts. */
const DEFAULT_FIRST_STEP_WAIT_MS = 5_000

/** Default cap on servers mounted into one agent. */
const DEFAULT_MAX_SERVERS_PER_AGENT = 16

/** Default per-tool-call timeout when a registry row does not set one. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Mounting configuration. */
export interface Config {
  /**
   * How long a session's first step may wait for its servers to connect before
   * the request goes out without them (milliseconds). Keeps a slow third-party
   * endpoint from stalling a conversation. A reconcile waits under the same
   * budget.
   */
  firstStepWaitMs?: number
  /**
   * Maximum servers mounted into one session. A model-facing tool list is a
   * context budget, so the tail of the effective set is dropped (with a warning)
   * rather than silently crowding out everything else.
   */
  maxServersPerAgent?: number
  /** Per-tool-call timeout applied to a row that does not set its own (milliseconds). */
  toolCallTimeoutMs?: number
}

/** Validate the mounting configuration. */
export const Config: Schema<Config> = z.object({
  firstStepWaitMs: z.natural().min(0).default(DEFAULT_FIRST_STEP_WAIT_MS)
    .description('How long a session first step waits for its external MCP servers before proceeding without them.'),
  maxServersPerAgent: z.natural().min(1).max(64).default(DEFAULT_MAX_SERVERS_PER_AGENT)
    .description('Maximum external MCP servers mounted into one session.'),
  toolCallTimeoutMs: z.natural().min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS)
    .description('Per-tool-call timeout applied to a registry row that does not set its own.'),
})

/** Mounting configuration with defaults resolved. */
export interface ResolvedConfig {
  /** See {@link Config.firstStepWaitMs}. */
  firstStepWaitMs: number
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
}

/**
 * How one server is connected. Production mounts the MCP client plugin into the
 * agent's scope; a test substitutes its own connector so it can assert which
 * servers a session was given without opening connections.
 */
export type ConnectServer = (target: Context, config: StreamableHttpConfig) => MountedConnection

/** Non-serializable hooks for tests; production omits them. */
export interface MountInternals {
  /** Replaces the MCP client mount. */
  connect?: ConnectServer
}

/**
 * What the plugin remembers about one live session: who it is for, what it has
 * mounted, and whether a registry write has made that stale.
 */
export interface AgentState {
  /** The session's user, captured where the ambient scope was still in reach. */
  readonly userId: string | undefined
  /** Mounts by mount name, with the fingerprint they were mounted from. */
  readonly mounted: Map<string, { fingerprint: string; connection: MountedConnection }>
  /** The first mount; the first step waits for it, every later step does not. */
  initial: Promise<void> | undefined
  /** Set when the registry wrote: the next step reconciles before it assembles. */
  stale: boolean
  /** Serializes mounts and reconciles, so two of them never interleave. */
  queue: Promise<void>
}

/**
 * Resolve configuration defaults.
 * @param config - validated configuration, possibly partial.
 * @returns the same configuration with every default filled in.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    firstStepWaitMs: config.firstStepWaitMs ?? DEFAULT_FIRST_STEP_WAIT_MS,
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
 * The servers one session may use: the system registry, plus the user's own when
 * a user is in scope.
 * @param store - the registry.
 * @param userId - the session's user, or undefined outside a user scope.
 * @returns the effective rows, capped by the caller.
 */
export function serversFor(store: McpServerStore, userId: string | undefined): EffectiveMcpServer[] {
  if (userId === undefined) return effectiveServers(store.system(), [], '')
  return store.effective(userId)
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
 * Bring one session's mounts in line with the registry: connect what is new,
 * reconnect what changed, disconnect what is gone, and leave untouched what is
 * still exactly what it was.
 * @param ctx - the plugin context, used for logging.
 * @param agent - the session whose scope holds the mounts.
 * @param store - the registry.
 * @param config - resolved mounting configuration.
 * @param state - what this session has mounted now; updated in place.
 * @param internals - test hooks; production omits them.
 */
async function reconcile(
  ctx: Context,
  agent: Agent,
  store: McpServerStore,
  config: ResolvedConfig,
  state: AgentState,
  internals: MountInternals,
): Promise<void> {
  const available = serversFor(store, state.userId)
  const desired = available.slice(0, config.maxServersPerAgent)
  if (available.length > desired.length) {
    ctx.logger.warn(
      `mcp-external: ${String(available.length)} servers are in effect but only ${String(desired.length)} are mounted `
      + '(maxServersPerAgent); raise the limit or register fewer servers',
    )
  }
  const wanted = new Map(desired.map(server => [server.mountName, server]))
  const connect: ConnectServer = internals.connect ?? ((target, client) => target.plugin(McpClient, client))

  // What left the effective set (removed, disabled, or pushed out by the cap).
  for (const [name, { connection }] of [...state.mounted]) {
    if (wanted.has(name)) continue
    state.mounted.delete(name)
    await closeMount(ctx, name, connection)
  }

  const work = [...wanted].map(async ([name, server]) => {
    const fingerprint = fingerprintOf(server, config)
    const current = state.mounted.get(name)
    if (current !== undefined) {
      if (current.fingerprint === fingerprint) return
      state.mounted.delete(name)
      await closeMount(ctx, name, current.connection)
    }
    const connection = connect(agent.ctx, toClientConfig(server, config))
    state.mounted.set(name, { fingerprint, connection })
    try {
      await connection
    } catch (error) {
      // A mount that never came up is not "mounted": leaving it recorded would
      // make every later reconcile consider it done and never retry.
      state.mounted.delete(name)
      ctx.logger.warn(
        `mcp-external: ${server.origin} server "${server.serverName}" (${server.mountName}) could not be mounted: ` + String(error),
      )
    }
  })
  await Promise.all(work)
}

/**
 * A session state with nothing mounted yet.
 * @param userId - the session's user, or undefined outside a user scope.
 * @returns the empty state.
 */
function emptyState(userId: string | undefined): AgentState {
  return { userId, mounted: new Map(), initial: undefined, stale: false, queue: Promise.resolve() }
}

/**
 * Mount every server a session may use into that session's scope.
 *
 * Mounts run concurrently and independently: one failing server is reported and
 * left out, and the others still mount. The registrations belong to the agent's
 * scope, so they disappear with the session.
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
  const state = emptyState(user === undefined ? undefined : String(user))
  await reconcile(ctx, agent, store, config, state, internals)
  return state
}

/**
 * Wait for a mount to settle, but no longer than the budget. Exposed because it
 * is the whole of the first-step guarantee: a step waits for its tools, and a
 * server that never answers costs one bounded wait rather than the turn.
 * @param mount - the mount work.
 * @param budgetMs - the longest wait.
 */
export async function awaitMount(mount: PromiseLike<unknown>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      mount,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Mount the effective servers for every session as it is created, hold a
 * session's first step until its mounts settle, and reconcile a live session's
 * mounts before the step that follows a registry write.
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
  const agents = new Map<Agent, AgentState>()

  /** Run `work` after whatever this session is already doing. */
  const enqueue = (state: AgentState, work: () => Promise<void>): Promise<void> => {
    const next = state.queue.then(work, work)
    state.queue = next.catch(() => {})
    return next
  }

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const user = currentUser()
    const state = emptyState(user === undefined ? undefined : String(user))
    agents.set(agent, state)
    state.initial = enqueue(state, () => reconcile(ctx, agent, store, resolved, state, internals))
  }, { global: true }), 'mcp-external: per-session mount')

  // A registry write does not mount anything by itself: it marks the sessions
  // that already have mounts as stale, and each one reconciles at its next step
  // boundary — where a tool may safely appear or disappear.
  ctx.effect(() => store.subscribe(() => {
    for (const state of agents.values()) state.stale = true
  }), 'mcp-external: registry subscription')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    // The mounts themselves are scope registrations and go with the agent; this
    // only stops the registry from tracking a session that no longer exists.
    agents.delete(agent)
  }, { global: true }), 'mcp-external: session bookkeeping')

  // A waterfall, so the first model request of a session already sees the
  // tools and a session whose registry changed carries the change on the next
  // step. Re-waiting on a mount that is not being retried would stall a
  // conversation on a server that is never going to answer, so both waits are
  // bounded by `firstStepWaitMs`.
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent }, next) => {
    const state = agents.get(agent)
    if (state !== undefined) {
      const initial = state.initial
      if (initial !== undefined) {
        state.initial = undefined
        await awaitMount(initial, resolved.firstStepWaitMs)
      } else if (state.stale) {
        state.stale = false
        await awaitMount(
          enqueue(state, () => reconcile(ctx, agent, store, resolved, state, internals)),
          resolved.firstStepWaitMs,
        )
      }
    }
    return next()
  }, { global: true }), 'mcp-external: first-step readiness and reconcile')
}
