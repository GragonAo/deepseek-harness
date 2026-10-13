/**
 * MCP tool-call concurrency: which of one server's calls may overlap, how many
 * of them may overlap at once, and which of them may be sent again.
 *
 * An MCP tool opts into a parallel group through the annotations it advertises
 * in `tools/list`. Those annotations are untrusted server input, so
 * `toolConcurrency.policy` overrides them in either direction, and
 * `toolConcurrency.exclusiveTools` removes named tools from overlap without
 * asking the server to declare anything.
 *
 * The per-server cap is independent of the harness-wide parallelism budget:
 * many servers each run their own share, while one slow or fragile server
 * cannot be handed every slot.
 *
 * A third-party server declares neither its capacity nor its willingness to
 * serve, so `toolConcurrency.mode: 'adaptive'` (the default) learns the cap from
 * what this client observed: each refusal to serve (see `overload.ts`)
 * multiplies the cap down, and each quiet window of successful calls adds one
 * slot back, up to `maxConcurrentCalls` and never below one. The learning is
 * state of one running plugin instance — it is not persisted and not shared
 * between processes.
 *
 * Repeating a call is a separate question from overlapping it, and it is
 * answered the other way round: nothing is retried unless the tool advertises
 * `readOnlyHint: true` or the deployment names it in
 * `toolConcurrency.retryTools`. A refusal that is retried is not an error the
 * model has to interpret, so the allow-list starts empty and grows only by
 * explicit statement.
 *
 * @module
 */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

/** How one server's tool annotations decide whether its MCP calls may overlap. */
export type ToolConcurrencyPolicy = 'annotations' | 'parallel' | 'exclusive'

/** How one server's call cap behaves over the life of the connection. */
export type ToolConcurrencyMode = 'fixed' | 'adaptive'

/** Per-server tool-call concurrency configuration. */
export interface ToolConcurrencyConfig {
  /**
   * Judgement rule for this server (default `annotations`). `annotations`
   * trusts `readOnlyHint` and `idempotentHint`; `parallel` allows every call to
   * overlap regardless of annotations; `exclusive` allows none, which is the
   * switch for a server whose annotations are wrong or whose tools must not
   * overlap.
   */
  policy?: ToolConcurrencyPolicy
  /**
   * Most `tools/call` requests this server may have in flight at once (default
   * 10, the harness-wide parallelism default). Calls beyond the cap wait in
   * submission order.
   */
  maxConcurrentCalls?: number
  /**
   * This server's own (raw) tool names whose calls must never overlap another
   * call, whatever `policy` says for the rest of its tools. The names are the
   * ones `tools/list` reports, not the model-facing `mcp__<server>__<name>`
   * form. Omission and an empty list both mean no tool is excluded — Schemastery
   * materializes a missing array key as `[]`, so the two are the same value and
   * an empty list names no referent to miss. Every listed name must exist in the
   * server's tool list; a name the server does not report fails the tool
   * synchronization that discovered the list, so a typo is never silently
   * ignored and a name is judged as soon as it is known.
   */
  exclusiveTools?: string[]
  /**
   * This server's own (raw) tool names whose calls may be sent again after a
   * refusal to serve, in addition to the tools whose own annotations declare
   * `readOnlyHint: true`. An empty list retries only those annotated read-only
   * tools, which is the fail-safe direction: a write is repeated only when the
   * deployment says naming it is safe, never because it was left out. Names are
   * judged exactly like `exclusiveTools` ones — a name the server does not
   * report fails that tool synchronization — and the two lists are independent:
   * a read-only tool that also needs its submission order preserved belongs in
   * both, while a tool that writes belongs in neither.
   */
  retryTools?: string[]
  /**
   * How this server's call cap behaves over time (default `adaptive`). `fixed`
   * holds `maxConcurrentCalls` for the life of the connection; `adaptive`
   * starts there and moves the cap down on a refusal to serve and back up while
   * calls succeed. Adaptive is the default because a third-party server
   * publishes no capacity to configure a correct fixed number with: too high
   * produces refusals, too low wastes the parallelism the caller asked for, and
   * the learned cap is bounded below by one call and above by the configured
   * maximum, so it cannot make a working server unusable. Set `fixed` to hold a
   * number the deployment has measured.
   */
  mode?: ToolConcurrencyMode
  /**
   * Fraction of the cap one refusal to serve keeps (default 0.5). Each refusal
   * multiplies the current cap, and the result never drops below one slot.
   */
  decreaseFactor?: number
  /** Slots added back by one recovery step (default 1). */
  recoveryStep?: number
  /**
   * Milliseconds without a refusal to serve before one recovery step is taken
   * (default 2000). A step also needs a call that completed, so an idle server
   * does not recover the cap on its own.
   */
  recoveryQuietMs?: number
  /**
   * Whether a `tools/call` that outlived `toolCallTimeoutMs` counts as a
   * refusal to serve (default true). A request-limited backend holds requests
   * until the pool frees, so its overload arrives as a timeout rather than an
   * error; a backend that is merely slow produces the same signal, and counting
   * it lowers the cap for a server that was never overloaded.
   */
  countTimeouts?: boolean
  /**
   * Extra attempts one call may make after a refusal to serve (default 0, no
   * retry). Retrying is what keeps a refused call from becoming a model-visible
   * error while the cap is still learning, and it is bounded: at most
   * `1 + retryAttempts` requests per call, each with its own `toolCallTimeoutMs`
   * budget, and the delays in between add to the call's wall-clock time. A tool
   * is never retried unless it advertises `readOnlyHint: true` or the deployment
   * names it in `retryTools`.
   */
  retryAttempts?: number
  /**
   * First retry delay in milliseconds; doubles per further attempt (default
   * 200). Queueing for a retry, like queueing for a first slot, is not charged
   * to the per-call timeout.
   */
  retryBaseDelayMs?: number
  /**
   * Fraction the retry delay is spread by, in `0..1` (default 0.2); `0` disables
   * jitter and makes every delay exact. Spread keeps calls refused together from
   * returning together and producing a fresh burst.
   */
  retryJitterRatio?: number
}

/** Defaults shared by the Config schema and {@link resolveToolConcurrencyPolicy}. */
export const TOOL_CONCURRENCY_DEFAULTS: Required<ToolConcurrencyConfig> = Object.freeze({
  policy: 'annotations',
  maxConcurrentCalls: 10,
  exclusiveTools: [],
  retryTools: [],
  mode: 'adaptive',
  decreaseFactor: 0.5,
  recoveryStep: 1,
  recoveryQuietMs: 2_000,
  countTimeouts: true,
  retryAttempts: 0,
  retryBaseDelayMs: 200,
  retryJitterRatio: 0.2,
})

/** Most extra attempts one call may make, bounding the wall-clock cost of `retryAttempts`. */
const MAX_RETRY_ATTEMPTS = 5

/** Lowest cap the adaptive mode may learn: a refusal never stops calls being sent. */
const MIN_CONCURRENT_CALLS = 1

/** Every accepted `mode` value, in the order diagnostics list them. */
const MODES: readonly ToolConcurrencyMode[] = ['fixed', 'adaptive']

/**
 * The one explicit resolve step from raw concurrency config to the policy the
 * bridge runs. Programmatic construction may bypass Schemastery normalization,
 * so every default and bound is re-judged here — misconfiguration fails the
 * plugin instance at load. `exclusiveTools` and `retryTools` resolve to sets
 * because membership is the only question the classifier asks of them.
 */
export interface ResolvedToolConcurrencyPolicy {
  /** Judgement rule applied to every tool of this server. */
  readonly policy: ToolConcurrencyPolicy
  /** Most `tools/call` requests this server may have in flight at once. */
  readonly maxConcurrentCalls: number
  /** Raw tool names of this server whose calls never overlap another call. */
  readonly exclusiveTools: ReadonlySet<string>
  /** Raw tool names of this server whose calls may be sent again after a refusal. */
  readonly retryTools: ReadonlySet<string>
  /** How the cap behaves over the life of the connection. */
  readonly mode: ToolConcurrencyMode
  /** Fraction of the cap one refusal to serve keeps. */
  readonly decreaseFactor: number
  /** Slots added back by one recovery step. */
  readonly recoveryStep: number
  /** Milliseconds without a refusal to serve before one recovery step is taken. */
  readonly recoveryQuietMs: number
  /** Whether a call that outlived `toolCallTimeoutMs` counts as a refusal to serve. */
  readonly countTimeouts: boolean
  /** Extra attempts one call may make after a refusal to serve. */
  readonly retryAttempts: number
  /** First retry delay in milliseconds, doubling per further attempt. */
  readonly retryBaseDelayMs: number
  /** Fraction the retry delay is spread by, in `0..1`. */
  readonly retryJitterRatio: number
}

/** Every accepted `policy` value, in the order diagnostics list them. */
const POLICIES: readonly ToolConcurrencyPolicy[] = ['annotations', 'parallel', 'exclusive']

/**
 * Whether the policy allows a tool that advertises `annotations` to join a
 * parallel group. `idempotentHint` alone permits overlap: two overlapping
 * calls are ordered by nothing, so a server asserting it must commute or fail
 * closed, which is what the annotation claims for repeats.
 */
const DECIDERS: Record<ToolConcurrencyPolicy, (annotations: ToolAnnotations | undefined) => boolean> = {
  annotations: annotations => annotations?.readOnlyHint === true || annotations?.idempotentHint === true,
  parallel: () => true,
  exclusive: () => false,
}

/**
 * Resolve raw `toolConcurrency` config.
 *
 * @param config - Raw `toolConcurrency` config; omission uses the defaults.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolveToolConcurrencyPolicy(
  config: ToolConcurrencyConfig | undefined,
  path: string,
): ResolvedToolConcurrencyPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(TOOL_CONCURRENCY_DEFAULTS, key)) throw new Error(`${path}.${key} is not a tool-concurrency option`)
    }
  }
  const policy = config?.policy ?? TOOL_CONCURRENCY_DEFAULTS.policy
  if (!POLICIES.includes(policy)) throw new Error(`${path}.policy must be one of ${POLICIES.join(', ')}`)
  const maxConcurrentCalls = config?.maxConcurrentCalls ?? TOOL_CONCURRENCY_DEFAULTS.maxConcurrentCalls
  if (!Number.isInteger(maxConcurrentCalls) || maxConcurrentCalls < 1) {
    throw new Error(`${path}.maxConcurrentCalls must be a positive integer`)
  }
  const exclusiveTools = config?.exclusiveTools
  for (const name of exclusiveTools ?? []) {
    if (name.trim().length === 0) throw new Error(`${path}.exclusiveTools must name non-empty tool names`)
  }
  const retryTools = config?.retryTools
  for (const name of retryTools ?? []) {
    if (name.trim().length === 0) throw new Error(`${path}.retryTools must name non-empty tool names`)
  }
  const mode = config?.mode ?? TOOL_CONCURRENCY_DEFAULTS.mode
  if (!MODES.includes(mode)) throw new Error(`${path}.mode must be one of ${MODES.join(', ')}`)
  const decreaseFactor = config?.decreaseFactor ?? TOOL_CONCURRENCY_DEFAULTS.decreaseFactor
  if (!Number.isFinite(decreaseFactor) || decreaseFactor <= 0 || decreaseFactor >= 1) {
    throw new Error(`${path}.decreaseFactor must be greater than 0 and less than 1`)
  }
  const recoveryStep = config?.recoveryStep ?? TOOL_CONCURRENCY_DEFAULTS.recoveryStep
  if (!Number.isInteger(recoveryStep) || recoveryStep < 1) {
    throw new Error(`${path}.recoveryStep must be a positive integer`)
  }
  const recoveryQuietMs = config?.recoveryQuietMs ?? TOOL_CONCURRENCY_DEFAULTS.recoveryQuietMs
  if (!Number.isInteger(recoveryQuietMs) || recoveryQuietMs < 1 || recoveryQuietMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.recoveryQuietMs must be an integer in 1..${MAX_TIMER_DELAY_MS}`)
  }
  const countTimeouts = config?.countTimeouts ?? TOOL_CONCURRENCY_DEFAULTS.countTimeouts
  if (typeof countTimeouts !== 'boolean') throw new Error(`${path}.countTimeouts must be a boolean`)
  const retryAttempts = config?.retryAttempts ?? TOOL_CONCURRENCY_DEFAULTS.retryAttempts
  if (!Number.isInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > MAX_RETRY_ATTEMPTS) {
    throw new Error(`${path}.retryAttempts must be an integer in 0..${MAX_RETRY_ATTEMPTS}`)
  }
  const retryBaseDelayMs = config?.retryBaseDelayMs ?? TOOL_CONCURRENCY_DEFAULTS.retryBaseDelayMs
  if (!Number.isInteger(retryBaseDelayMs) || retryBaseDelayMs < 1 || retryBaseDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.retryBaseDelayMs must be an integer in 1..${MAX_TIMER_DELAY_MS}`)
  }
  const retryJitterRatio = config?.retryJitterRatio ?? TOOL_CONCURRENCY_DEFAULTS.retryJitterRatio
  if (!Number.isFinite(retryJitterRatio) || retryJitterRatio < 0 || retryJitterRatio > 1) {
    throw new Error(`${path}.retryJitterRatio must be a number in 0..1`)
  }
  return Object.freeze({
    policy,
    maxConcurrentCalls,
    exclusiveTools: new Set(exclusiveTools),
    retryTools: new Set(retryTools),
    mode,
    decreaseFactor,
    recoveryStep,
    recoveryQuietMs,
    countTimeouts,
    retryAttempts,
    retryBaseDelayMs,
    retryJitterRatio,
  })
}

/** A configured tool name that the discovered `tools/list` did not report. */
export interface UnknownListedTool {
  /** The `toolConcurrency` list that named it, so a diagnostic points at the fix. */
  readonly field: 'exclusiveTools' | 'retryTools'
  /** The configured raw tool name the server did not report. */
  readonly name: string
}

/**
 * The names in `exclusiveTools` or `retryTools` that a server's discovered tool
 * list does not contain, in the order the configuration names them.
 *
 * Both lists are checked here, at the first point where the names they refer to
 * exist: configuration loads before the server is asked for its tools, and a
 * name that refers to nothing is a configuration error rather than something to
 * ignore. A `retryTools` typo would be fail-safe — the tool is simply never
 * retried — and it is still reported, because the deployment stated that
 * repeating that call is safe and that statement has no referent.
 *
 * @param policy - Resolved per-server policy.
 * @param discovered - Raw tool names the server's `tools/list` reported.
 * @returns The unknown names, each with the list that named it; empty when every configured name was discovered.
 */
export function unknownListedTools(
  policy: ResolvedToolConcurrencyPolicy,
  discovered: Iterable<string>,
): UnknownListedTool[] {
  const known = new Set(discovered)
  const unknown: UnknownListedTool[] = []
  for (const field of ['exclusiveTools', 'retryTools'] as const) {
    for (const name of policy[field]) {
      if (!known.has(name)) unknown.push({ field, name })
    }
  }
  return unknown
}

/**
 * One call waiting for a slot. It leaves the queue exactly once — granted by
 * {@link fill}, failed by its own abort listener, or failed by `close` — so a
 * granted or failed waiter is never handed a slot afterwards.
 */
interface Waiter {
  /** Detaches this waiter's abort listener. */
  readonly forget: () => void
  readonly grant: (release: () => void) => void
  readonly fail: (reason: unknown) => void
}

/**
 * Cap on one MCP server's overlapping `tools/call` requests.
 *
 * Calls beyond the cap wait in submission order rather than failing: the model
 * asked for each one, and the cap exists to bound load on the server, not to
 * reject work. Waiting is not charged to the per-call timeout — that budget
 * starts inside the SDK's `client.request()`, which a queued call has not
 * reached yet.
 */
export interface ConcurrencyLimiter {
  /**
   * Acquire one slot for a call about to be sent.
   * @param signal - the call's cancellation signal. An aborted signal rejects
   *   instead of acquiring: queued and in-flight calls both settle, so disposal
   *   never leaves a caller waiting for a slot that will not be handed over.
   * @returns an idempotent release function; call it once the request settled.
   */
  acquire(signal: AbortSignal): Promise<() => void>
  /**
   * Close the limiter: every queued call rejects with `reason`, later
   * acquisitions reject too, and already-granted slots keep working so a
   * request that is already on the wire is not stranded.
   * @param reason - the rejection every queued and future caller receives.
   */
  close(reason: Error): void
  /**
   * Record how one attempt at the server ended, which is the cap's only input in
   * adaptive mode. A granted slot is never revoked by this: a cap that drops
   * below the calls already in flight stops admitting new ones until they
   * release, and every granted call finishes.
   * @param outcome - `served` for an attempt the server answered, `overload` for
   *   one that refused to serve.
   */
  report(outcome: ToolCallOutcome): void
}

/** How one attempt at the server ended, as far as the cap's learning signal knows. */
export type ToolCallOutcome = 'served' | 'overload'

/** Non-serializable hooks used to make the adaptive cap deterministic in tests. */
export interface ToolConcurrencyInternals {
  /** Clock in milliseconds used by the recovery window; defaults to `Date.now`. */
  now?: () => number
}

/**
 * Present an aborted call's rejection as an `Error`. `AbortSignal.reason` is
 * `any` and a caller may abort with a non-`Error` value, which a rejection
 * carries as its cause instead.
 *
 * @param reason - `AbortSignal.reason` of the aborted signal.
 * @returns The reason when it is already an `Error`, otherwise a new `Error` carrying it as its cause.
 */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('the call was aborted before it acquired a slot', { cause: reason })
}

/**
 * Build one server's call limiter from its validated policy, so the slot count
 * has exactly one validation point ({@link resolveToolConcurrencyPolicy}).
 *
 * In adaptive mode the cap starts at `maxConcurrentCalls` and is moved by
 * {@link ConcurrencyLimiter.report}: a refusal to serve multiplies it by
 * `decreaseFactor` (never below one slot), and one `recoveryQuietMs` window
 * without a refusal buys one `recoveryStep` back, taken by a call that
 * completed. Both bounds are the union of this instance's observations: the
 * cap never rises above `maxConcurrentCalls`, and the state dies with the
 * plugin instance.
 *
 * @param policy - Resolved tool-call concurrency policy.
 * @param internals - Non-serializable hooks; only tests pass them.
 * @returns The limiter this server's calls share.
 */
export function createToolCallLimiter(
  policy: ResolvedToolConcurrencyPolicy,
  internals: ToolConcurrencyInternals = {},
): ConcurrencyLimiter {
  const configured = policy.maxConcurrentCalls
  const adaptive = policy.mode === 'adaptive'
  const now = internals.now ?? Date.now
  let limit = configured
  /** When the last refusal to serve arrived, so a recovery step waits out the window. */
  let lastOverloadAt = now()
  /** When the cap last rose, so one quiet window buys one step. */
  let lastStepAt = lastOverloadAt
  const waiters: Waiter[] = []
  let active = 0
  let closed: Error | undefined

  /** Hand free slots to queued calls in submission order. */
  const fill = (): void => {
    while (active < limit) {
      const waiter = waiters.shift()
      if (waiter === undefined) return
      waiter.forget()
      active += 1
      let released = false
      waiter.grant(() => {
        if (released) return
        released = true
        active -= 1
        fill()
      })
    }
  }

  return {
    acquire(signal: AbortSignal): Promise<() => void> {
      if (closed !== undefined) return Promise.reject(closed)
      // An already-aborted signal never fires its listener, so queueing it would
      // wait forever behind a full limit.
      if (signal.aborted) return Promise.reject(abortError(signal.reason))
      const pending = new Promise<() => void>((grant, fail) => {
        const waiter: Waiter = {
          forget: () => { signal.removeEventListener('abort', onAbort) },
          grant,
          fail,
        }
        function onAbort(): void {
          // This listener is live only while the waiter is queued: `fill` and
          // `close` both detach it before the waiter leaves the queue, and a
          // granted call observes its own signal at the SDK request.
          waiters.splice(waiters.indexOf(waiter), 1)
          fail(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
      fill()
      return pending
    },
    close(reason: Error): void {
      closed = reason
      for (const waiter of waiters.splice(0)) {
        waiter.forget()
        waiter.fail(reason)
      }
    },
    report(outcome: ToolCallOutcome): void {
      if (!adaptive) return
      const at = now()
      if (outcome === 'overload') {
        lastOverloadAt = at
        const next = Math.max(MIN_CONCURRENT_CALLS, Math.floor(limit * policy.decreaseFactor))
        if (next !== limit) limit = next
        return
      }
      if (limit === configured) return
      if (at - lastOverloadAt < policy.recoveryQuietMs) return
      if (at - lastStepAt < policy.recoveryQuietMs) return
      limit = Math.min(configured, limit + policy.recoveryStep)
      lastStepAt = at
      fill()
    },
  }
}

/**
 * Whether one call may overlap sibling calls under `policy`: `exclusiveTools`
 * membership first, then the annotations rule for the remaining tools. An
 * annotations rule sees absent or false hints as exclusive — only a positive
 * safety claim opts in, which is the fail-closed direction.
 *
 * @param policy - Resolved per-server policy.
 * @param annotations - The tool's advertised annotations, untrusted wire data.
 * @param rawName - The server's own name for this tool, as `exclusiveTools` spells it.
 * @returns Whether calls to this tool may join a parallel group.
 */
export function allowsConcurrentCalls(
  policy: ResolvedToolConcurrencyPolicy,
  annotations: ToolAnnotations | undefined,
  rawName: string,
): boolean {
  if (policy.exclusiveTools.has(rawName)) return false
  return DECIDERS[policy.policy](annotations)
}

/**
 * Whether one call to this tool may be sent again after a refusal to serve.
 *
 * Repeating a call is not the same question as overlapping it, and it is
 * answered by a different allow-list: a tool qualifies when its own MCP
 * annotations declare `readOnlyHint: true`, or when the deployment names it in
 * `retryTools`. Nothing else is retried, so an empty `retryTools` retries only
 * tools that stated they are read-only — the fail-safe direction, where a write
 * is repeated only because someone said repeating it is safe.
 *
 * `idempotentHint` is deliberately not enough on its own: it is the server's
 * claim about repeats, and `policy` already exists because a third-party
 * server's claims cannot be verified. A deployment that trusts it lists the
 * tool in `retryTools` instead, which states the same fact where the deployment
 * owns it.
 *
 * @param policy - Resolved per-server policy.
 * @param annotations - The tool's advertised annotations, untrusted wire data.
 * @param rawName - The server's own name for this tool, as `retryTools` spells it.
 * @returns Whether the bridge may retry this tool after a refusal to serve.
 */
export function allowsAutomaticRetry(
  policy: ResolvedToolConcurrencyPolicy,
  annotations: ToolAnnotations | undefined,
  rawName: string,
): boolean {
  return annotations?.readOnlyHint === true || policy.retryTools.has(rawName)
}

/**
 * One retry delay: `retryBaseDelayMs` doubled per attempt, spread by
 * `retryJitterRatio` so calls refused together do not return together. The
 * spread is symmetric around the exact delay, so the mean is unchanged and the
 * delay is never negative.
 *
 * @param policy - Resolved per-server policy carrying the delay configuration.
 * @param attempt - 1-based ordinal of the retry being waited for, at most `retryAttempts`.
 * @param random - Sample in `[0, 1)`; production passes `Math.random`.
 * @returns The delay in milliseconds.
 */
export function retryDelayMs(
  policy: ResolvedToolConcurrencyPolicy,
  attempt: number,
  random: () => number,
): number {
  const exact = policy.retryBaseDelayMs * 2 ** (attempt - 1)
  const spread = 1 - policy.retryJitterRatio + 2 * policy.retryJitterRatio * random()
  return Math.max(0, Math.round(exact * spread))
}

/**
 * Wait out one retry delay, unless the call is cancelled while waiting.
 *
 * @param delayMs - Delay in milliseconds.
 * @param signal - The call's cancellation signal.
 * @returns True once the delay elapsed, false when the signal aborted first.
 */
export function waitBeforeRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
