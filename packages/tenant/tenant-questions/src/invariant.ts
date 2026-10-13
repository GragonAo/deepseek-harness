/** Package-owned tenant-question audit-stream invariants. @module @deepseek-ai/dsh-tenant-questions/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { TenantQuestionId, TenantQuestionOutcome } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tenant-questions'
/** Closed outcome vocabulary; typed so a value the domain type lacks cannot be listed here. */
const OUTCOMES: readonly TenantQuestionOutcome[] = ['answered', 'timed-out', 'cancelled']

/** Cordis companion plugin name. */
export const name = 'tenant-questions-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

type QuestionTransition =
  | { kind: 'asked'; id: TenantQuestionId; questionIds: Set<string> }
  | { kind: 'decided'; id: TenantQuestionId }

interface QuestionTrace {
  /** Turn depth marker: null between turns, the `turn/start` number inside one. */
  openTurn: number | null
  /** Open asks by id, carrying the question ids each one put. */
  open: Map<TenantQuestionId, Set<string>>
}

/**
 * Check one accepted answer against the ask it resolves: every item answers a
 * question that ask put, answers each of them once, and leaves none unanswered —
 * the relation that makes an answer the whole batch the asker awaits.
 * @param asked - the question ids the matching `user-question/asked` put.
 * @param answers - the answered question ids, in the order the answer carries.
 * @param fail - the invariant failure reporter.
 */
function validateAnswer(asked: ReadonlySet<string>, answers: readonly { id: string }[], fail: InvariantFailure): void {
  const answered = new Set<string>()
  for (const item of answers) {
    if (!asked.has(item.id)) fail(`user-question/decided answers ${JSON.stringify(item.id)}, which the ask did not put`)
    if (answered.has(item.id)) fail(`user-question/decided answers ${JSON.stringify(item.id)} twice`)
    answered.add(item.id)
  }
  for (const id of asked) {
    if (!answered.has(id)) fail(`user-question/decided leaves question ${JSON.stringify(id)} unanswered`)
  }
}

/** Validate one tenant-question event against the committed open asks. */
function validateQuestionEvent(
  trace: QuestionTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): QuestionTransition | undefined {
  if (event.type === 'user-question/asked') {
    if (trace.openTurn === null) fail('user-question/asked appended outside any open turn')
    if (event.data.questions.length === 0) fail('user-question/asked put no question')
    const questionIds = new Set<string>()
    for (const question of event.data.questions) {
      if (questionIds.has(question.id)) fail(`user-question/asked repeats question id ${JSON.stringify(question.id)}`)
      questionIds.add(question.id)
    }
    if (trace.open.has(event.data.id)) fail(`user-question/asked repeated open ask id ${JSON.stringify(event.data.id)}`)
    return { kind: 'asked', id: event.data.id, questionIds }
  }
  if (event.type === 'user-question/decided') {
    if (trace.openTurn === null) fail('user-question/decided appended outside any open turn')
    const asked = trace.open.get(event.data.id)
    if (asked === undefined) fail(`user-question/decided has no matching user-question/asked for id ${JSON.stringify(event.data.id)}`)
    if (!OUTCOMES.includes(event.data.outcome)) {
      fail(`user-question/decided carries unknown outcome ${JSON.stringify(event.data.outcome)}`)
    }
    const answered = event.data.outcome === 'answered'
    if (answered !== (event.data.answer !== undefined)) {
      fail(`user-question/decided outcome ${JSON.stringify(event.data.outcome)} must carry an answer exactly when it was answered`)
    }
    if (event.data.answer !== undefined && asked !== undefined) validateAnswer(asked, event.data.answer.answers, fail)
    return { kind: 'decided', id: event.data.id }
  }
  return undefined
}

/** Apply one accepted audit-pair transition. */
function applyQuestionTransition(trace: QuestionTrace, transition: QuestionTransition): void {
  if (transition.kind === 'asked') trace.open.set(transition.id, transition.questionIds)
  else trace.open.delete(transition.id)
}

/** Install audit pairing and closed-vocabulary checks. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, QuestionTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: QuestionTransition }>()
  const seed = (session: Session): QuestionTrace => {
    const trace: QuestionTrace = { openTurn: null, open: new Map() }
    traces.set(session, trace)
    for (const event of session.events) {
      if (event.type === 'turn/start') trace.openTurn = event.data.turn
      else if (event.type === 'turn/end') trace.openTurn = null
      const transition = validateQuestionEvent(trace, event, fail)
      if (transition !== undefined) applyQuestionTransition(trace, transition)
    }
    return trace
  }
  const traceFor = (session: Session): QuestionTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const trace = traceFor(session)
    if (event.type === 'turn/start') {
      trace.openTurn = event.data.turn
      return
    }
    if (event.type === 'turn/end') {
      trace.openTurn = null
      return
    }
    if (event.type !== 'user-question/asked' && event.type !== 'user-question/decided') return
    const candidate = staged.get(event)
    /* v8 ignore next -- internal/dispatch stages every package-owned pair event */
    if (candidate === undefined || candidate.session !== session) return fail('tenant-question audit event published without pre-commit validation')
    staged.delete(event)
    applyQuestionTransition(trace, candidate.transition)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const transition = validateQuestionEvent(traceFor(session), event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the tenant-question invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
