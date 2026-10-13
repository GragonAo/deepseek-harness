/**
 * Durable vocabulary of the driver's own automatic-continuation releases: the
 * two log-only session events an operator or monitor reads when a goal stops
 * continuing itself. Both are observational — the goal fold, the projections,
 * and every lifecycle decision ignore them, and activation stays process-local.
 * @module @deepseek-ai/dsh-goal-round-driver/types
 */

import type { GoalRef } from '@deepseek-ai/dsh-goal'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One release of a goal's automatic continuation: the durable counterpart
     * of `GoalService.disarm()`, which itself writes no event.
     */
    'goal-round-driver/disarmed': GoalRoundDriverDisarmedEvent
    /** The automatic re-arm that followed a scheduled error retry; its absence after a release reports no scheduled retry. */
    'goal-round-driver/rearmed': GoalRoundDriverRearmedEvent
  }
}

/**
 * Why the driver released a goal's automatic continuation. Each cause is the
 * driver-owned decision that removed authority; distinguishing them keeps an
 * operator alert actionable, and separates a failure the driver retries from a
 * human or policy decision it must not override.
 */
export type GoalRoundDriverDisarmCause =
  /** An agent error surfaced with no driver-owned cause of its own. */
  | 'agent-error'
  /** The durability checkpoint (`ctx.sessions.flush`) failed. */
  | 'checkpoint-failed'
  /** A drive pass threw. */
  | 'driver-failed'
  /** The agent's initiator scope could not be entered to start a drive pass. */
  | 'scheduler-unavailable'
  /** The serialized drive task settled rejected. */
  | 'driver-task-rejected'
  /** The pre-step reservation check failed. */
  | 'pre-step-check-failed'
  /** The reservation check after downstream pre-step listeners failed. */
  | 'post-decision-check-failed'
  /** A cancelled reservation could not be paused durably. */
  | 'pause-failed'
  /** The round's turn hit the model output limit. */
  | 'max-tokens'
  /** The round's turn was aborted with no reserved attempt to blame. */
  | 'turn-aborted'
  /** This driver instance was unloaded. */
  | 'unload'
  /** This driver instance loaded over an agent an earlier instance had armed. */
  | 'load'

/** One scheduled automatic re-arm of a goal the driver released after a failure. */
export interface GoalRoundDriverRetry {
  /** One-based attempt number this release schedules. */
  readonly attempt: number
  /** Configured `maxErrorRetries` ceiling. */
  readonly maxAttempts: number
  /** Configured constant delay before the re-arm, in milliseconds. */
  readonly delayMs: number
}

/** Durable record of one release of a goal's automatic continuation. */
export interface GoalRoundDriverDisarmedEvent {
  /** Goal whose automatic continuation was released. */
  readonly goalId: GoalRef['id']
  /** Goal revision at the release; a later revision is a different continuation policy decision. */
  readonly revision: number
  /** Rounds admitted when continuation was released. */
  readonly roundsStarted: number
  /** Driver-owned cause of the release. */
  readonly cause: GoalRoundDriverDisarmCause
  /** Failure text for a cause that carries one. */
  readonly detail?: string
  /** The scheduled automatic retry, or `null` when continuation stays released until a human resume. */
  readonly retry: GoalRoundDriverRetry | null
}

/** Durable record of the automatic re-arm that followed a scheduled error retry. */
export interface GoalRoundDriverRearmedEvent {
  /** Goal that was re-armed. */
  readonly goalId: GoalRef['id']
  /** Revision committed by the re-arm, one past the released revision. */
  readonly revision: number
  /** The retry that produced this re-arm. */
  readonly retry: GoalRoundDriverRetry
}
