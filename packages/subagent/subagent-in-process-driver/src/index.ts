/**
 * Shared driver for in-process ONE-SHOT subagent providers. The agent factory's
 * creation transaction owns unpublished setup and rollback; after publication
 * the returned AgentHandle is the one quiescent lifecycle owner held by the
 * provider's caller.
 *
 * Continuable children never come through here: the continuation manager
 * composes and drives them directly, so this driver owns exactly one turn with
 * one result.
 *
 * The run's result always settles: `settleTimeoutMs` bounds the wait for the
 * child's quiescence and cancels a child that stopped making progress, so neither
 * `result` nor the `dispose()` awaiting it can stay pending forever.
 *
 * @module @deepseek-ai/dsh-subagent-in-process-driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentDescriptorData,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  attachStructuredRuntime,
  type StructuredAttachment,
} from './structured.ts'

export {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from './structured.ts'

/** Map a session turn outcome to the subagent seam's terminal vocabulary. */
function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // A pre-step rejection discarded the claimed prompt: the task was
    // declined, and the caller must not read the run as done.
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** Default for {@link Config.settleTimeoutMs}. */
const DEFAULT_SETTLE_TIMEOUT_MS = 3_600_000

/** Deadline code this driver stamps on its own expiry. */
const SETTLE_TIMEOUT = 'SUBAGENT_SETTLE_TIMEOUT'

/**
 * Config: the shared driver's deployment-varying bound. The provider plugins that
 * call {@link startInProcessRun} expose this field on their own config.
 */
export interface Config {
  /**
   * Milliseconds a published child may run before the driver stops waiting for
   * it, cancels it, and settles the run with a diagnostic. Defaults to 3600000 —
   * longer than any tool-level deadline, because this bound only has to fire for
   * a child that stopped responding to cancellation entirely.
   */
  settleTimeoutMs?: number
}

/** Validated schema for {@link Config}; the driver applies its own default. */
export const Config: z<Config> = z.object({
  settleTimeoutMs: z.natural().min(1).default(DEFAULT_SETTLE_TIMEOUT_MS),
})

/** Extra inputs the spawn and fork providers supply to the shared driver. */
export interface InProcessRunOptions extends Config {
  /** Completed-turn seed for fork, or undefined for a fresh spawn. */
  readonly seed?: SessionEvent[]
}

/** Error used when cancellation wins before the child publication boundary. */
function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

/** Append one one-shot descriptor inside the child's initial turn before its first request. */
function attachDescriptorAppend(childCtx: Context, descriptor: SubagentDescriptorData): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/**
 * Establish and drive one in-process one-shot child. Fulfillment means the agent
 * is already published in the registry and transfers its turn, cancellation,
 * and disposal work through the returned run. Rejection means the agent
 * factory's unpublished creation transaction reached quiescence without
 * publishing a child. Every start appends its resolved descriptor inside the
 * child's initial turn.
 * @param request - the trusted typed start request, including its required signal.
 * @param options - the optional fork seed.
 * @returns a published holder-owned run.
 */
export async function startInProcessRun(
  request: ResolvedSubagentStartRequest,
  options: InProcessRunOptions,
): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw prePublicationAbort()
  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)

  const childId = SessionId(randomUUID())
  const seed = options.seed
  const activationBoundary = seed?.length ?? 0

  // Capture before the first await: a later parent switch belongs to the
  // parent's future.
  const inherited = captureDelegatedPolicyOverrides(parent)

  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context): void => {
    appendDelegatedPolicyOverrides((childCtx.agent as Agent).session, inherited)
    applyChildComposition(childCtx, parent, {
      persona: request.persona,
      toolFilter: request.toolFilter,
    })
    if (request.outputSchema !== undefined) {
      structured = attachStructuredRuntime(childCtx, request.outputSchema)
    }
    attachDescriptorAppend(childCtx, request.descriptor)
  }

  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    meta: childSessionMeta(parent, childDepth, activationBoundary),
    ...seed !== undefined ? { seed } : {},
    agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
    signal: request.signal,
    setup,
  })
  return drivePublishedRun(
    handle,
    request.signal,
    request.prompt,
    childId,
    activationBoundary,
    structured,
    options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
  )
}

/**
 * Wrap a published child in the single run lifecycle that owns signal handoff,
 * one turn, result settlement, and quiescent disposal.
 */
function drivePublishedRun(
  handle: AgentHandle,
  signal: AbortSignal,
  prompt: ContentBlock[],
  childId: SessionId,
  boundary: number,
  structured: StructuredAttachment | undefined,
  settleTimeoutMs: number,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // Agent creation detaches its creation-only listener before returning. The
  // post-registration check closes that handoff without treating an already
  // published child as a failed start.
  if (signal.aborted) onAbort()

  const result: Promise<SubagentResult> = (async () => {
    // The deadline carries no upstream: caller cancellation already reaches the
    // child through `onAbort`, which cancels it and so ends the same wait. Only
    // this driver's own expiry means the child stopped responding.
    using d = deadline(undefined, settleTimeoutMs, SETTLE_TIMEOUT)
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await awaitQuiescence(child, d.signal)
      }
      const captured = structured ? { captured: structured.captured() } : undefined
      if (timeoutOf(d.signal, SETTLE_TIMEOUT) === undefined) {
        return readResult(child, boundary, flags.cancelled, captured)
      }
      // The child outlived the deadline: cancel it so its loop stops, and report
      // why this run stopped waiting instead of leaving the parent with no result
      // at all.
      flags.cancelled = true
      child.cancel({ kind: 'parent' })
      return {
        ...readResult(child, boundary, true, captured),
        diagnostic: `subagent run did not settle within ${settleTimeoutMs}ms`,
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const settlements = await Promise.allSettled([handle.dispose(), result])
      const disposal = settlements[0]
      // The result channel owns run faults; disposal reports only failure to
      // release the published handle after both operations settle.
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

/**
 * Await a published child's quiescence, ending the wait when `signal` aborts.
 *
 * `whenIdle()` is not cancellable: the signal ends this await, and the caller
 * cancels the child so its own loop stops.
 *
 * @param child - the published child whose quiescence is awaited.
 * @param signal - the settle deadline.
 * @returns fulfillment once the child is quiescent, or once `signal` aborts.
 */
async function awaitQuiescence(child: Agent, signal: AbortSignal): Promise<void> {
  await Promise.race([
    child.whenIdle(),
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    }),
  ])
}

/** Read one settled child's result from events after its activation boundary. */
function readResult(
  child: Agent,
  boundary: number,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
): SubagentResult {
  const own = child.session.events.slice(boundary)
  // `droppedUnrun` is deliberately unread: a one-shot prompt is claimed by its
  // awaited first turn almost immediately, and the owner's own teardown is the
  // `cancelled` flag below. A cancellation with no accounting turn resolves
  // `error` through `toStopReason(undefined)`, which never overstates success.
  const lastEnd = foldConsumedWork(own).end
  // The seam's canonical selection rule; a partial answer survives cancel and truncation.
  const output: ContentBlock[] = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  // Disposal can tear the owner down before the loop records its ordinary
  // `aborted` end, yielding `disposed` instead.
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  if (structured !== undefined) {
    if (structured.captured !== undefined) {
      return { output, structured: structured.captured.value, stopReason }
    }
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}
