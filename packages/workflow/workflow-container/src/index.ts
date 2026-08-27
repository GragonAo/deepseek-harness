/**
 * Container workflow engine. Each run executes its model-written script in the
 * tenant tool-exec container (off the agent host), bridging `agent()` calls back
 * to host subagents over a per-run duplex HTTP bridge. It reuses the
 * worker-thread's entire worker-side runtime unchanged; the container is the
 * isolation boundary, just as it is for bash/fs/subprocess/code tools.
 * @module @deepseek-ai/dsh-workflow-container
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import * as vm from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WorkflowEngine, { WorkflowError, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { validateMeta } from '@deepseek-ai/dsh-workflow-worker-thread'
import type { WorkerInit, WorkerLimits } from '@deepseek-ai/dsh-workflow-worker-thread'
import { ContainerRun } from './host.ts'
import { createHttpMessagePort, createWorkflowBridge } from './transport.ts'
import type { WorkflowBridge } from './transport.ts'

export { createHttpMessagePort, createWorkflowBridge }
export type { WorkflowBridge }

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** The `ctx.subagents` provider children run on (default `spawn`). */
  provider?: string
  /** Concurrent `agent()` ceiling; `0` (the default) auto-resolves to `min(16, max(1, cores - 2))`. */
  maxConcurrentAgents?: number
  /** Total `agent()` calls one run may start — the runaway-loop backstop (default 1000). */
  maxTotalAgents?: number
  /** Items accepted by a single `parallel()`/`pipeline()` call (default 4096). */
  maxItemsPerCall?: number
  /** vm timeout for the script's initial synchronous slice, inside the container (default 5000 ms). */
  syncTimeoutMs?: number
  /**
   * How long after a cancellation an unsettled script may keep running before
   * the run force-settles `cancelled` and its container process is ABORTED
   * (default 5000 ms); also bounds `dispose()`.
   */
  disposeGraceMs?: number
  /** The hostname the container reaches the host bridge by (default `host.docker.internal`; Podman uses `host.containers.internal`). */
  hostBridge?: string
}

type ResolvedConfig = Required<Config>

/**
 * Locate the self-contained container worker bundle. Built launch resolves
 * `./container-worker.js` beside `lib/index.js`; source launch (the `dsh` CLI
 * runs through tsx) resolves the same bundle one level up from `src/index.ts`.
 * Fails loud when neither exists — the package must be built before launch.
 * @param importUrl - the module URL to resolve against (`import.meta.url`).
 * @returns the bundle text.
 */
function resolveWorkerBundle(importUrl: string): string {
  const direct = new URL('./container-worker.js', importUrl)
  if (existsSync(direct)) return readFileSync(direct, 'utf8')
  const built = new URL('../lib/container-worker.js', importUrl)
  if (existsSync(built)) return readFileSync(built, 'utf8')
  throw new Error('@deepseek-ai/dsh-workflow-container: lib/container-worker.js missing — build the package before launching (pnpm run build)')
}

/** A body that still carries the Claude Code-style meta header (meta rides the seam as data here). */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/

/**
 * Parse-check the body with the SAME wrapper the worker-side runtime compiles,
 * so `start()` keeps the seam's synchronous `SCRIPT_PARSE` throw (the worker's
 * own compile happens in the container, after `start()` returned).
 */
function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError('workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body', 'SCRIPT_PARSE')
  }
  try {
    void new vm.Script(`(async () => {\n${body}\n})()`, { filename: `workflow:${name}`, lineOffset: -1 })
  } catch (error: unknown) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
  }
}

/** Resolve one run's provider route before publishing work. */
function resolveSubagentProvider(ctx: Context, configured: string, override: string | undefined): string {
  const provider = override ?? configured
  if (provider.length === 0 || provider !== provider.trim()) {
    throw new WorkflowError('workflow subagentProvider must be a non-empty normalized string', 'INVALID_ARGUMENT')
  }
  if (ctx.subagents.getProvider(provider) === undefined) {
    throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START')
  }
  return provider
}

/** Resolve one run's total-child cap against the engine deployment ceiling. */
function resolveMaxTotalAgents(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT')
  }
  if (requested > ceiling) {
    throw new WorkflowError(`workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`, 'INVALID_ARGUMENT')
  }
  return requested
}

/**
 * The container engine service. `start()` validates the script up front (meta
 * + a host-side body parse) and returns a {@link WorkflowRun} whose `result`
 * never rejects; the `workflow/*` events fire around the run per the seam
 * contract. The bundled container worker is read lazily from this package's
 * built `lib/container-worker.js`.
 */
export default class ContainerWorkflowEngine extends WorkflowEngine {
  static inject = ['containerRuntime', 'subagents']

  static Config: z<Config> = z.object({
    provider: z.string().default('spawn'),
    maxConcurrentAgents: z.natural().default(0),
    maxTotalAgents: z.natural().min(1).default(1000),
    maxItemsPerCall: z.natural().min(1).default(4096),
    syncTimeoutMs: z.natural().min(1).default(5000),
    disposeGraceMs: z.natural().default(5000),
    hostBridge: z.string().default('host.docker.internal'),
  })

  private readonly config: ResolvedConfig
  private bundle: string | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
  }

  /**
   * Validate and execute a workflow script inside the tenant container. Throws
   * {@link WorkflowError} synchronously (`META_INVALID` for a malformed meta
   * block, `SCRIPT_PARSE` for a body that does not compile) for a request that
   * cannot begin; once a run is returned, every failure resolves through
   * `result.stopReason` instead.
   * @param request - the script body, its meta data and `args`, the parent
   *   agent, and an optional cancel signal.
   * @returns the live run (its `result` resolves when the script settles).
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const subagentProvider = resolveSubagentProvider(this.ctx, this.config.provider, request.subagentProvider)
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents)
    const id = WorkflowRunId(randomUUID())
    const info: WorkflowRunInfo = { id, meta }
    const limits: WorkerLimits = {
      maxConcurrentAgents: this.config.maxConcurrentAgents === 0
        ? Math.min(16, Math.max(1, availableParallelism() - 2))
        : this.config.maxConcurrentAgents,
      maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    }
    const init: WorkerInit = {
      meta,
      body: request.script,
      ...request.args !== undefined ? { args: request.args } : {},
      limits,
    }
    // Capture dependencies while this service call is still traced through the
    // start() holder, so an already-returned run can keep starting children
    // after an engine HMR unload removes ctx.workflowEngine.
    const runCtx = this.ctx
    const subagents = runCtx.subagents
    const containerRuntime = runCtx.containerRuntime
    // The bundled worker is read once; `hostBridge` is threaded into the run so
    // the container can reach the host bridge by its gateway name.
    this.bundle = this.bundle ?? resolveWorkerBundle(import.meta.url)
    const workerRun = new ContainerRun(
      runCtx,
      containerRuntime,
      subagents,
      id,
      meta,
      request.parent,
      init,
      subagentProvider,
      this.config.disposeGraceMs,
      {
        phase: (title) => { this.emitWorkflowEvent('workflow/phase', info, title) },
        log: (message) => { this.emitWorkflowEvent('workflow/log', info, message) },
        agentStart: (agent) => { this.emitWorkflowEvent('workflow/agent-start', info, agent) },
        agentEnd: (agent) => { this.emitWorkflowEvent('workflow/agent-end', info, agent) },
      },
      this.bundle,
      this.config.hostBridge,
      request.signal,
    )

    this.emitWorkflowEvent('workflow/start', info)
    void workerRun.result.then((settled) => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
      })
    })

    return workerRun
  }
}
