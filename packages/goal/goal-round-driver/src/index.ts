/**
 * Same-session goal-round driver over public agent, session, and goal services.
 * @module @deepseek-ai/dsh-goal-round-driver
 */

import { isDeepStrictEqual } from 'node:util'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalMessageSource, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  GoalRoundDriverDisarmedEvent,
  GoalRoundDriverDisarmCause,
  GoalRoundDriverRearmedEvent,
  GoalRoundDriverRetry,
} from './types.ts'
import { renderGoalRoundPrompt } from './prompt.ts'

export { renderGoalRoundPrompt } from './prompt.ts'
// The durable release vocabulary (./types.ts) holds the SessionEventMap merge
// this package owns; re-exporting it keeps that module edge in the emitted
// declarations, so a consumer reading the two events compiles against them.
export type * from './types.ts'

export const name = 'goal-round-driver'
export const inject = ['agents', 'goals', 'sessions']

/**
 * Deployment policy for a goal round that failed. A failure releases automatic
 * continuation first — no other trigger may restart a round before the retry
 * fires — and the bounded retry re-arms the goal after
 * {@link RETRY_DEFAULTS.errorRetryDelayMs}. The bound, not the delay, is what
 * stops a goal that keeps failing from spending its round budget: every retry
 * is one admitted goal round.
 */
export interface Config {
  /**
   * Consecutive failure-driven releases retried before continuation stays
   * released for a human resume (default 3). `0` disables automatic retry.
   */
  maxErrorRetries?: number
  /** Delay before the first automatic re-arm in milliseconds; each consecutive attempt doubles it (default 5000). */
  errorRetryDelayMs?: number
}

/** Defaults shared by the Config schema and {@link resolveConfig}. */
export const RETRY_DEFAULTS = Object.freeze({
  maxErrorRetries: 3,
  errorRetryDelayMs: 5000,
})

export const Config: z<Config> = z.object({
  maxErrorRetries: z.number().default(RETRY_DEFAULTS.maxErrorRetries),
  errorRetryDelayMs: z.number().default(RETRY_DEFAULTS.errorRetryDelayMs),
})

/** Validated {@link Config} with every default materialized. */
interface ResolvedConfig {
  /** Validated non-negative retry ceiling. */
  readonly maxErrorRetries: number
  /** Validated non-negative base re-arm delay. */
  readonly errorRetryDelayMs: number
}

/**
 * Validate the deployment policy at plugin load: a fractional, negative, or
 * non-finite value is a misconfiguration, never a silent fall-back.
 * @param config - the plugin config after schemastery defaulting.
 * @returns the resolved policy.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const maxErrorRetries = config.maxErrorRetries ?? RETRY_DEFAULTS.maxErrorRetries
  const errorRetryDelayMs = config.errorRetryDelayMs ?? RETRY_DEFAULTS.errorRetryDelayMs
  if (!Number.isSafeInteger(maxErrorRetries) || maxErrorRetries < 0) {
    throw new Error(`goal-round-driver: invalid maxErrorRetries ${maxErrorRetries} — must be a non-negative safe integer`)
  }
  if (!Number.isSafeInteger(errorRetryDelayMs) || errorRetryDelayMs < 0) {
    throw new Error(`goal-round-driver: invalid errorRetryDelayMs ${errorRetryDelayMs} — must be a non-negative safe integer`)
  }
  return { maxErrorRetries, errorRetryDelayMs }
}

/** Identity reserved before a goal continuation enters the agent inbox. */
interface RoundIdentity {
  readonly goalId: GoalRef['id']
  readonly revision: number
  readonly round: number
}

/** One queued, claimed, or admitted goal message retained until whole-agent quiescence. */
interface RoundAttempt extends RoundIdentity {
  readonly messageId: MessageId
  readonly content: ContentBlock[]
  phase: 'queued' | 'claimed' | 'admitted'
  cancelled: boolean
  stale: boolean
}

/** One release of automatic continuation and the automatic retry it schedules, if any. */
interface Release {
  readonly cause: GoalRoundDriverDisarmCause
  readonly detail?: string
  readonly retry: GoalRoundDriverRetry | null
}

/** A scheduled automatic re-arm; any later release or lifecycle edge supersedes it. */
interface PendingRetry {
  /** Exact goal revision whose authority the release removed. */
  readonly ref: GoalRef
  readonly retry: GoalRoundDriverRetry
  readonly timer: ReturnType<typeof setTimeout>
}

/** Serialized process-local scheduling state for one exact Agent lifecycle. */
interface DriverState {
  readonly agent: Agent
  attempt: RoundAttempt | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
  /** Consecutive failure-driven releases with no completed round between them. */
  errorRetries: number
  pendingRetry: PendingRetry | undefined
}

/** Whether a source identifies an automatic, positive-numbered goal round. */
function isGoalRoundSource(source: MessageSource): source is GoalMessageSource {
  return source.kind === 'goal' && source.round > 0
}

/** Compare a source to one reserved identity. */
function sameRound(source: GoalMessageSource, round: RoundIdentity): boolean {
  return source.goalId === round.goalId
    && source.revision === round.revision
    && source.round === round.round
}

/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content: ContentBlock[], source: MessageSource, attempt: RoundAttempt): boolean {
  return isGoalRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content)
}

/** Exact current ref for a view. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Operator-facing notice for one release. It states the goal, the driver-owned
 * cause with its failure text, and what happens to automatic continuation next,
 * because the release itself leaves no other operator-visible trace.
 */
function renderReleaseNotice(goal: GoalView, data: GoalRoundDriverDisarmedEvent): string {
  const reason = data.detail === undefined ? data.cause : `${data.cause}: ${data.detail}`
  const continuation = data.retry === null
    ? 'resume the goal to continue'
    : `automatic retry in ${data.retry.delayMs} ms (attempt ${data.retry.attempt} of ${data.retry.maxAttempts})`
  return `goal-round-driver: released automatic continuation for goal "${goal.id}" revision ${goal.revision} (${reason}); ${continuation}`
}

/** Install automatic same-session continuation and its race fences. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const states = new Map<Agent, DriverState>()

  /** Create state for an exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      attempt: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
      errorRetries: 0,
      pendingRetry: undefined,
    }
    states.set(agent, state)
    return state
  }

  /** Read only when the exact Agent remains live. */
  function currentGoal(state: DriverState): GoalView | undefined {
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    return ctx.goals.get(state.agent)
  }

  /** Whether this exact lifecycle is quiescent with no competing prompt. */
  function readyToDrive(state: DriverState): boolean {
    return ctx.fiber.state === FiberState.ACTIVE
      && !state.stopping
      && ctx.agents.get(state.agent.id) === state.agent
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** Recheck every condition that an awaited checkpoint may have changed. */
  function readyAfterCheckpoint(state: DriverState): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }

  /** Drop a scheduled automatic re-arm; every later release and lifecycle edge supersedes it. */
  function cancelPendingRetry(state: DriverState): void {
    const pending = state.pendingRetry
    if (pending === undefined) return
    state.pendingRetry = undefined
    clearTimeout(pending.timer)
  }

  /**
   * Apply one release: supersede any scheduled re-arm, remove process-local
   * authority, and record the release durably plus on the operator log. A goal
   * that is not armed has no authority to remove, so it reports nothing.
   * @param state - the exact agent lifecycle releasing authority.
   * @param release - driver-owned cause and the retry it schedules, if any.
   * @returns the exact ref the release applied to, absent when nothing was released.
   */
  function applyRelease(state: DriverState, release: Release): GoalRef | undefined {
    cancelPendingRetry(state)
    const goal = currentGoal(state)
    if (goal?.activation !== 'armed') return undefined
    try {
      ctx.goals.disarm(state.agent)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not release automatic continuation for agent "${state.agent.id}": ${renderThrown(error)}`)
      return undefined
    }
    // The release has happened. A failure to record it must not revoke it, nor
    // cancel the retry the caller schedules from this return.
    const data: GoalRoundDriverDisarmedEvent = {
      goalId: goal.id,
      revision: goal.revision,
      roundsStarted: goal.roundsStarted,
      cause: release.cause,
      ...release.detail === undefined ? {} : { detail: release.detail },
      retry: release.retry,
    }
    try {
      state.agent.session.append('goal-round-driver/disarmed', data)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not record the release of goal "${goal.id}": ${renderThrown(error)}`)
    }
    ctx.logger.warn(renderReleaseNotice(goal, data))
    return goalRef(goal)
  }

  /** Release automatic continuation for a decision no automatic retry may override. */
  function release(state: DriverState, cause: GoalRoundDriverDisarmCause, detail?: string): void {
    applyRelease(state, { cause, ...(detail === undefined ? {} : { detail }), retry: null })
  }

  /**
   * Release automatic continuation after a failure, then schedule its bounded
   * retry. The counter advances only for a release that removed authority, and
   * an attempt past the configured bound leaves the goal released until a human
   * resume — the release event reports which of the two happened.
   */
  function releaseAfterFailure(state: DriverState, cause: GoalRoundDriverDisarmCause, detail: string): void {
    const attempt = state.errorRetries + 1
    const retry: GoalRoundDriverRetry | null = attempt <= resolved.maxErrorRetries
      ? {
        attempt,
        maxAttempts: resolved.maxErrorRetries,
        delayMs: resolved.errorRetryDelayMs * 2 ** (attempt - 1),
      }
      : null
    const ref = applyRelease(state, { cause, detail, retry })
    if (ref === undefined) return
    state.errorRetries = attempt
    if (retry === null) return
    state.pendingRetry = {
      ref,
      retry,
      timer: setTimeout(() => { fireRetry(state, ref, retry) }, retry.delayMs),
    }
  }

  /**
   * Re-arm and re-drive the exact revision the release removed authority from.
   * A different current goal — a human pause, edit, clear, or a new goal —
   * supersedes the retry and leaves the goal as that decision left it.
   */
  function fireRetry(state: DriverState, ref: GoalRef, retry: GoalRoundDriverRetry): void {
    state.pendingRetry = undefined
    const goal = currentGoal(state)
    if (goal === undefined || goal.id !== ref.id || goal.revision !== ref.revision) return
    try {
      const armed = ctx.goals.resume(state.agent, goalRef(goal))
      const data: GoalRoundDriverRearmedEvent = {
        goalId: armed.id,
        revision: armed.revision,
        retry,
      }
      state.agent.session.append('goal-round-driver/rearmed', data)
      ctx.logger.info(
        `goal-round-driver: re-armed goal "${armed.id}" revision ${armed.revision} `
        + `(attempt ${retry.attempt}/${retry.maxAttempts})`,
      )
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not re-arm goal "${goal.id}" for agent "${state.agent.id}": ${renderThrown(error)}`)
      return
    }
    requestDrive(state)
  }

  /** Preserve claimed step context when this driver drops only its own round. */
  function restoreOtherClaimed(agent: Agent, messages: UserMessage[], messageId: MessageId): void {
    const retained = messages.filter(message => message.id !== messageId
      && !(message.source.kind === 'goal' && message.source.round === 0))
    for (const message of retained.toReversed()) {
      if (agent.inbox.nextStep.some(candidate => candidate.id === message.id)
        || agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
  }

  /** Process admitted work at quiescence, then reserve at most one next round. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        releaseAfterFailure(state, 'checkpoint-failed', renderThrown(error))
        return
      }
      // A mutation or ordinary prompt may have arrived while the checkpoint
      // was settling. Give it its own checkpoint / turn before reserving.
      if (!readyAfterCheckpoint(state)) return
    }

    const attempt = state.attempt
    if (attempt !== undefined) {
      state.attempt = undefined
      state.needsCheckpoint = true
      state.requested = true
      return
    }

    const goal = currentGoal(state)
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      ctx.goals.block(agent, goalRef(goal), {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      return
    }

    const round = goal.roundsStarted + 1
    const content = renderGoalRoundPrompt(goal, round)
    const message = createUserMessage({
      content,
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
    })
    const reservation: RoundAttempt = {
      goalId: goal.id,
      revision: goal.revision,
      round,
      messageId: message.id,
      content,
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    state.attempt = reservation
    try {
      agent.followup(message)
    } catch (error: unknown) {
      state.attempt = undefined
      ctx.logger.warn(`goal-round-driver: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
      const latest = currentGoal(state)
      if (latest !== undefined && latest.id === goal.id && latest.revision === goal.revision
        && latest.phase === 'active' && latest.activation === 'armed') {
        ctx.goals.block(agent, goalRef(latest), {
          code: 'queue-failed',
          message: `Could not queue goal round ${round}: ${renderThrown(error)}`,
        })
      }
    }
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing the step fence */
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            releaseAfterFailure(state, 'driver-failed', renderThrown(error))
          }
        }
      })
    } catch (error: unknown) {
      releaseAfterFailure(state, 'scheduler-unavailable', renderThrown(error))
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      releaseAfterFailure(state, 'driver-task-rejected', renderThrown(error))
      retire()
    })
  }

  // One composite effect keeps the step fence installed until this
  // plugin's own scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('agent/error', ({ agent, error }) => {
      const state = stateFor(agent)
      releaseAfterFailure(state, 'agent-error', renderThrown(error))
    })

    ctx.on('agent/created', ({ agent }) => { stateFor(agent) })
    ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })
    ctx.on('agent/session-start', ({ agent }) => {
      const state = stateFor(agent)
      cancelPendingRetry(state)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
      state.errorRetries = 0
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        state.competingQueued = false
        const attempt = state.attempt
        const goal = currentGoal(state)
        if ((attempt?.phase === 'queued' || attempt?.phase === 'claimed' || attempt?.cancelled)
          && goal?.phase === 'active' && goal.activation === 'armed') {
          state.attempt = undefined
          try {
            ctx.goals.pause(agent, goalRef(goal))
          } catch (error: unknown) {
            release(state, 'pause-failed', renderThrown(error))
          }
        }
        requestDrive(state)
      }
    })
    ctx.on('goal/changed', ({ agent }) => {
      const state = stateFor(agent)
      state.needsCheckpoint = true
      requestDrive(state)
    })

    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) return
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.phase = 'claimed'
      }
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.cancelled = true
      }
    })

    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'user/message':
          if (state.attempt !== undefined && event.data.id === state.attempt.messageId) {
            state.attempt.phase = 'admitted'
          }
          return
        case 'turn/end':
          if (event.data.reason.kind === 'max-tokens') {
            release(state, 'max-tokens')
            return
          }
          // The driver's own round finished without an error: the runtime
          // demonstrably recovered, so the retry counter restarts. A failure
          // that ended the turn never reaches this branch.
          if (event.data.reason.kind === 'completed' && state.attempt?.phase === 'admitted') {
            state.errorRetries = 0
            return
          }
          if (event.data.reason.kind !== 'aborted') return
          if (state.attempt?.phase === 'claimed' || state.attempt?.phase === 'admitted') {
            state.attempt.cancelled = true
          }
          else release(state, 'turn-aborted')
          return
        default:
          return
      }
    })

    /** Fail closed unless the queued prompt still owns the exact live revision. */
    function validReservation(
      state: DriverState,
      content: ContentBlock[],
      source: GoalMessageSource,
    ): boolean {
      const attempt = state.attempt
      const goal = currentGoal(state)
      return ctx.fiber.state === FiberState.ACTIVE
        && !state.stopping && attempt !== undefined && attempt.phase === 'claimed'
      && !attempt.stale && sameQueued(content, source, attempt)
      && goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
      && goal.phase === 'active' && goal.activation === 'armed'
      && source.round === goal.roundsStarted + 1
    }

    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const submitted = messages.find((message): message is UserMessage & { source: GoalMessageSource } =>
        isGoalRoundSource(message.source))
      if (submitted === undefined) return next()
      const { content, source } = submitted
      const state = stateFor(agent)
      let valid = false
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`)
        releaseAfterFailure(state, 'pre-step-check-failed', renderThrown(error))
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt)) {
          attempt.stale = true
          state.attempt = undefined
        }
        restoreOtherClaimed(agent, messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      let decision: PreStepDecision
      try {
        decision = await next()
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // A throwing downstream hook drops the whole step proposal. Clear the
        // reservation before the balanced no-step turn returns to idle so the
        // next drive pass can reschedule the round.
        state.attempt = undefined
        requestDrive(state)
        throw error
      }
      if (signal.aborted) {
        if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
        return decision
      }
      if (decision.kind === 'reject') {
        state.attempt = undefined
        const goal = currentGoal(state)
        if (goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
          && goal.phase === 'active' && goal.activation === 'armed') {
          ctx.goals.block(agent, goalRef(goal), {
            code: 'prompt-rejected',
            message: 'Goal round was rejected before entering its step.',
          })
        }
        return decision
      }
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`)
        releaseAfterFailure(state, 'post-decision-check-failed', renderThrown(error))
        valid = false
      }
      if (!valid) {
        state.attempt = undefined
        restoreOtherClaimed(agent, decision.messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      return decision
    })

    // Loading a lifecycle driver over existing agents never inherits hidden
    // automatic authority from an earlier producer instance.
    for (const agent of ctx.agents.list()) {
      const state = stateFor(agent)
      release(state, 'load')
    }

    // Yielded after listener registration, so this close runs first and the
    // composite effect removes listeners only after its promise settles.
    yield async () => {
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        release(state, 'unload')
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          /* v8 ignore next -- followup reserves the live agent before publishing a queued attempt */
          if (state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'goal-round-driver lifecycle')
}
