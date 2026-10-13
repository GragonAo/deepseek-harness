/**
 * Tenant question channel (`ctx.tenantQuestions`): the multi-tenant
 * implementation of the user-questions seam. A question asked inside a session
 * is recorded as a `user-question/asked` event and held as a pending ask in this
 * process; the business plane reads the question from the session log (the
 * `session/event` frame of the existing `events.mux` stream, or
 * `POST /api/tenantQuestion.list`) and answers it through
 * `POST /api/tenantQuestion.answer`, which wakes the tool call that asked.
 *
 * The session log is the durable record of what was asked and how it ended; the
 * pending table only answers, so an answer is accepted while the ask waits in
 * this process and nowhere else.
 *
 * @module @deepseek-ai/dsh-tenant-questions
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { currentTenant, currentUser, requireTenant, requireUser } from '@deepseek-ai/dsh-tenant'
import type { TenantId, UserId } from '@deepseek-ai/dsh-tenant'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest, UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenantQuestions: TenantQuestionService
  }
}

/**
 * Opaque cross-boundary ask id: it pairs one `user-question/asked` with its
 * `user-question/decided` and names the ask on the business surface.
 * Channel-issued (one fresh id per ask), so two asks of one session — or asks of
 * two sessions that reused a caller-provided question id — stay distinguishable.
 */
export type TenantQuestionId = Branded<'TenantQuestionId'>

/**
 * Brand a freshly minted ask id (a plain cast — zero runtime cost).
 * @param id - the uuid to brand.
 * @returns the branded ask id.
 */
export function TenantQuestionId(id: string): TenantQuestionId {
  return id as TenantQuestionId
}

/**
 * How one ask ended. `'timed-out'` is this channel's own configured deadline;
 * the user-questions seam's longer deadline withdraws the ask instead and
 * records `'cancelled'`.
 */
export type TenantQuestionOutcome = 'answered' | 'timed-out' | 'cancelled'

/** One ask the ambient subject may still answer. */
export interface TenantPendingQuestion {
  /** Id the answer must name. */
  readonly id: TenantQuestionId
  /** The session whose waiting tool call the answer wakes. */
  readonly sessionId: Session['id']
  /** The ask exactly as the tool call submitted it. */
  readonly questions: readonly AskUserQuestionItem[]
  /** Epoch milliseconds this ask's answer deadline falls at. */
  readonly expiresAtMs: number
}

/** Acknowledgement of one accepted answer. */
export interface TenantQuestionAnswerReceipt {
  /** The ask that was resolved. */
  readonly questionId: TenantQuestionId
  /** The session whose tool call was woken. */
  readonly sessionId: Session['id']
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A question was put to the tenant's business plane — log-only record,
     * durable, replayable, never in the model transcript (like `approval/*`;
     * NOT a surface event, carries no `surfaceOp`). `id` pairs it with the
     * `user-question/decided` that resolves it, and `questions` is the ask
     * exactly as the tool call submitted it, so a business subscriber renders
     * the question from this event alone. The model learns the question from its
     * own tool call and the answer from the tool result.
     */
    'user-question/asked': {
      /** Ask id, echoed by the answer and by `user-question/decided`. */
      id: TenantQuestionId
      /** Questions put to the business plane, in submission order. */
      questions: AskUserQuestionItem[]
    }
    /**
     * How a prior `user-question/asked` (same `id`) ended — log-only, durable,
     * never in the model transcript. Appended exactly once, when the outcome is
     * known: `'answered'` carries the accepted answer, `'timed-out'` is this
     * channel's configured deadline, and `'cancelled'` is a withdrawn ask (turn
     * cancellation, or the seam's own longer deadline).
     */
    'user-question/decided': {
      /** Ask id this resolves. */
      id: TenantQuestionId
      /** How the ask ended. */
      outcome: TenantQuestionOutcome
      /** The accepted answer; present exactly when `outcome` is `'answered'`. */
      answer?: AskUserQuestionAnswer
    }
  }
}

/**
 * Milliseconds a question waits for a business answer before the ask rejects
 * with this channel's timeout. Deployment-varying rather than fixed: a deployment
 * whose business plane answers within seconds wants a short wait, while one whose
 * staff answer from a queue wants minutes.
 */
const DEFAULT_ANSWER_TIMEOUT_MS = 60_000

/**
 * Service configuration.
 *
 * `answerTimeoutMs` must stay below the `user-questions` seam's own
 * `answerTimeoutMs`: reaching the seam's deadline withdraws the ask through the
 * provider's abort signal, so a longer window here would leave the model with the
 * seam's generic no-answer failure instead of this channel's explicit timeout.
 */
export interface Config {
  /** Milliseconds an unanswered question waits before `ask()` rejects with the timeout. */
  answerTimeoutMs?: number
}

/**
 * One business-plane method's call into {@link TenantQuestionService}: the
 * carrier answers the method's wire name with `questions` under the authority of
 * the request it is serving, and its return value becomes the response `value`.
 */
export type TenantQuestionMethod = (questions: TenantQuestionService, payload: unknown) => Promise<unknown>

/**
 * The business-plane methods this channel answers, keyed by their wire name:
 * `POST /api/<name>` with the surface's own client-request envelope, one entry
 * per operation, pairing the name with the `ctx.tenantQuestions` call it makes.
 *
 * The tenant business surface otherwise serves the shared gateway's method map,
 * which is closed and identical in every deployment, so a method that exists only
 * under multi-tenancy names itself here and the carrier answers it before
 * delegating.
 */
export const TENANT_QUESTION_METHODS: ReadonlyMap<string, TenantQuestionMethod> =
  new Map<string, TenantQuestionMethod>([
    ['tenantQuestion.list', async questions => questions.list()],
    ['tenantQuestion.answer', async (questions, payload) => await questions.answer(payload)],
  ])

/** One ask this process is waiting to answer. */
interface PendingQuestion {
  /** Ask id: the key of the pending table and the id an answer names. */
  readonly id: TenantQuestionId
  /** Tenant whose business plane may answer. */
  readonly tenant: TenantId
  /** Subject whose business plane may answer. */
  readonly user: UserId
  /** Session the question was asked in: the log the audit pair lands in. */
  readonly session: Session
  /** Questions as the log recorded them. */
  readonly questions: AskUserQuestionItem[]
  /** Epoch milliseconds the answer deadline falls at. */
  readonly expiresAtMs: number
  /** Resolve the waiting tool call. */
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  /**
   * Reject the waiting tool call. The reason is an `Error` in every path this
   * channel decides, and the session log's own thrown value when the resolution
   * append failed — handed on rather than replaced, so the turn learns what the
   * log actually refused.
   */
  readonly reject: (reason?: unknown) => void
  /** Detach this ask's deadline and abort listener; assigned before the ask is registered. */
  release?: () => void
}

/**
 * Tenant question channel: the user-questions provider a multi-tenant deployment
 * mounts, plus the business-plane methods that answer it.
 *
 * It owns one ask's whole lifecycle: this service appends the audit pair, holds
 * the pending ask, and settles it — the first of answer, deadline, abort, or
 * disposal to claim an ask wins, and every other path then finds no ask.
 */
export class TenantQuestionService extends Service {
  static inject = ['userQuestions']
  static Config: z<Config> = z.object({
    answerTimeoutMs: z.natural().min(1).default(DEFAULT_ANSWER_TIMEOUT_MS),
  })

  private readonly answerTimeoutMs: number
  private readonly pending = new Map<TenantQuestionId, PendingQuestion>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tenantQuestions')
    this.answerTimeoutMs = config.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
    ctx.effect(
      () => ctx.userQuestions.registerProvider({ ask: request => this.ask(request) } satisfies UserQuestionProvider),
      'tenantQuestions.registerProvider()',
    )
    // Disposal reaches quiescence: no answer can arrive for an ask whose channel
    // is gone, so every waiting tool call is released instead of holding its turn
    // until the deadline.
    ctx.effect(() => () => {
      for (const pending of [...this.pending.values()]) this.abandon(pending)
    }, 'tenantQuestions: settle pending asks on disposal')
  }

  /**
   * The asks the ambient subject may still answer, oldest first.
   *
   * Wire method `tenantQuestion.list`: `POST /api/tenantQuestion.list` with an
   * empty payload. It is the recovery path for a business subscriber that missed
   * the `user-question/asked` event — the durable record of what was asked is the
   * session log, not this table.
   *
   * @returns one view per live ask of the ambient (tenant, subject); questions a
   *   different subject owns are never listed.
   * @throws {TenantError} `NO_TENANT_IN_SCOPE` or `NO_USER_IN_SCOPE` outside a
   *   request that proved both (the carrier enters both before calling this).
   */
  list(): TenantPendingQuestion[] {
    const tenant = requireTenant()
    const user = requireUser()
    return [...this.pending.values()]
      .filter(pending => pending.tenant === tenant.id && pending.user === user)
      .map(pending => ({
        id: pending.id,
        sessionId: pending.session.id,
        questions: pending.questions,
        expiresAtMs: pending.expiresAtMs,
      }))
  }

  /**
   * Accept one answer and wake the tool call that asked.
   *
   * Wire method `tenantQuestion.answer`: `POST /api/tenantQuestion.answer` with
   * the payload `{ sessionId, questionId, answer }`, where `answer` is
   * `{ answers: [{ id, selected, custom? }] }` carrying one item per question of
   * that ask. The payload is accepted only when it names an ask still waiting for
   * the ambient (tenant, subject) in that same session, and when every item
   * answers one of that ask's questions with labels the question itself offered —
   * so a stale id, another subject's question, or another session's ask cannot be
   * answered here.
   *
   * @param payload - the request payload, unvalidated: which answers are
   *   acceptable depends on the ambient subject's live asks, so the schema is
   *   built per call rather than declared.
   * @returns the ask that was resolved and the session whose tool call it woke.
   * @throws {ZodError} when the payload names no answerable ask, or its answer
   *   does not answer that ask (the carrier answers `bad-request` with the
   *   issues).
   * @throws when the `user-question/decided` append fails: an answer is reported
   *   accepted only once its resolution is logged.
   */
  async answer(payload: unknown): Promise<TenantQuestionAnswerReceipt> {
    const tenant = requireTenant()
    const user = requireUser()
    const live = [...this.pending.values()]
      .filter(pending => pending.tenant === tenant.id && pending.user === user)
    const accepted = answerPayloadSchema(live).parse(payload)
    const pending = live.find(candidate => String(candidate.id) === accepted.questionId)
    /* v8 ignore next 3 -- the branch that accepted this payload was built from
       this same `live` list in this synchronous pass, so the ask is still here. */
    if (pending === undefined) {
      throw new Error(`question ${JSON.stringify(accepted.questionId)} stopped waiting while its answer was validated`)
    }
    const answer = toAnswer(accepted.answer)
    const failure = this.settle(pending, 'answered', answer)
    if (failure !== undefined) {
      // The waiting turn is released either way: an answer whose resolution did
      // not commit must not leave the tool call waiting for the deadline.
      pending.reject(failure)
      throw failure
    }
    pending.resolve(answer)
    return { questionId: pending.id, sessionId: pending.session.id }
  }

  /**
   * Ask the ambient tenant's business plane and wait for its answer.
   *
   * Called only by the user-questions seam, which has already checked that a
   * supplied agent is the exact live runtime root.
   *
   * @param request - the seam's questions, owning agent, and abort signal.
   * @returns the answer the business plane submitted.
   * @throws {UserQuestionError} `ASK_MISSING_AGENT` for an agentless ask (a tenant
   *   question is bound to the session it was asked in), `NO_QUESTION_SCOPE`
   *   outside an authenticated business request, `NO_OPEN_TURN` outside an open
   *   turn, `DUPLICATE_QUESTION_ID` for an ask an answer could not address,
   *   `ANSWER_TIMEOUT` when the deadline passes, and `ASK_ABORTED` when the ask is
   *   withdrawn.
   */
  private async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (agent === undefined) {
      throw new UserQuestionError(
        'the tenant question channel requires the agent whose session the question belongs to',
        'ASK_MISSING_AGENT')
    }
    const tenant = currentTenant()
    const user = currentUser()
    if (tenant === undefined || user === undefined) {
      throw new UserQuestionError(
        'this deployment answers questions through the tenant business API, which is reachable only while a session '
        + 'runs inside an authenticated request; this call has no tenant and subject in scope. Do not call '
        + 'ask_user_question again: proceed with your best judgement, state the assumption you made explicitly, and '
        + 'name the decision the user should confirm.',
        'NO_QUESTION_SCOPE')
    }
    const session = agent.session
    // The audit pair must be turn-enclosed: the turn is the durable log's
    // commit/replay boundary, so a bare event appended between turns is
    // indistinguishable from a crash tail and silently dropped on reload.
    if (!hasOpenTurn(session.events)) {
      throw new UserQuestionError(
        'ask_user_question outside an open turn: the user-question/asked + user-question/decided pair must be '
        + 'turn-enclosed. Ask from inside the turn that needs the answer.',
        'NO_OPEN_TURN')
    }
    // An ask is answerable only if its questions can be addressed: one answer item
    // per question id, so a repeated id must be refused before the ask is recorded
    // rather than after the business tried to answer it. (The seam already refuses
    // an empty batch, so this is the only unaddressable ask left to catch.)
    const ids = new Set<string>()
    for (const question of request.questions) {
      if (ids.has(question.id)) {
        throw new UserQuestionError(
          `ask_user_question repeated question id ${JSON.stringify(question.id)}: ids must be distinct within one ask, `
          + 'so the answer can name exactly one question. Ask again with a distinct id for each question.',
          'DUPLICATE_QUESTION_ID')
      }
      ids.add(question.id)
    }
    const id = TenantQuestionId(randomUUID())
    // The logged snapshot, never the caller's array, is what answers are
    // validated against: the log is the authoritative record of what was asked.
    const asked = session.append('user-question/asked', { id, questions: request.questions })
    return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const pending: PendingQuestion = {
        id,
        tenant: tenant.id,
        user,
        session,
        questions: asked.data.questions,
        expiresAtMs: Date.now() + this.answerTimeoutMs,
        resolve,
        reject,
      }
      const timer = setTimeout(() => { this.timeout(pending) }, this.answerTimeoutMs)
      timer.unref?.()
      const onAbort = (): void => { this.abandon(pending) }
      pending.release = () => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, pending)
      // The seam refuses an already-aborted signal before it calls a provider, and
      // everything above this line runs in the caller's synchronous frame, so a
      // live signal here cannot have been aborted before this listener existed.
      request.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** The configured deadline passed: record it and reject with the reason to act on. */
  private timeout(pending: PendingQuestion): void {
    const failure = this.settle(pending, 'timed-out')
    pending.reject(failure ?? new UserQuestionError(
      `question ${JSON.stringify(String(pending.id))} was not answered within ${String(this.answerTimeoutMs)}ms, and the `
      + 'question is no longer answerable. Do not call ask_user_question again for this decision: proceed with your '
      + 'best judgement, state the assumption you made explicitly, and name the decision the user should confirm.',
      'ANSWER_TIMEOUT'))
  }

  /** The ask was withdrawn (turn cancellation, or the seam's own deadline). */
  private abandon(pending: PendingQuestion): void {
    const failure = this.settle(pending, 'cancelled')
    pending.reject(failure ?? new UserQuestionError(
      'ask_user_question was aborted before the business plane answered', 'ASK_ABORTED'))
  }

  /**
   * Claim one live ask and append how it ended. Claiming is the synchronous
   * removal from the pending table, so the first claimant wins: an answer racing
   * the deadline settles one outcome, never two, and an answer arriving after the
   * outcome finds no ask to answer.
   *
   * @param pending - the ask to settle.
   * @param outcome - how it ended.
   * @param answer - the accepted answer, when the business plane submitted one.
   * @returns the failure the resolution append raised, or undefined when the
   *   outcome committed: a caller reports its own outcome only then, because an
   *   unlogged resolution would leave the audit pair unfinishable. The failure is
   *   the append's own thrown value — the session store, the JSON check, and the
   *   audit invariant all throw `Error`s — handed on rather than replaced, so the
   *   waiting turn learns what the log actually refused.
   */
  private settle(
    pending: PendingQuestion,
    outcome: TenantQuestionOutcome,
    answer?: AskUserQuestionAnswer,
  ): unknown {
    this.pending.delete(pending.id)
    pending.release?.()
    try {
      pending.session.append('user-question/decided', {
        id: pending.id,
        outcome,
        ...answer === undefined ? {} : { answer },
      })
      return undefined
    } catch (error: unknown) {
      return error
    }
  }
}

/**
 * Whether the log currently sits inside an open turn (a `turn/start` not yet
 * closed by a `turn/end`) — the {@link TenantQuestionService} ask precondition.
 * @param events - the session log to scan.
 * @returns true while the last turn boundary was a `turn/start`.
 */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = (events[index] as SessionEvent).type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * The answer payload schema for one subject's live asks: one branch per live ask,
 * each binding the payload to that ask's session and question id and validating
 * the answer against the questions it asked.
 *
 * Built from the live asks rather than declared, because "answerable" is exactly
 * this subject's live asks: a question already answered, timed out, or cancelled
 * — or one another subject is being asked — has no branch, so its answer cannot
 * be accepted here.
 *
 * @param live - the ambient subject's live asks, in ask order.
 * @returns a schema that accepts only an answer to one of them.
 */
function answerPayloadSchema(live: readonly PendingQuestion[]) {
  if (live.length === 0) return NOTHING_ASKED_SCHEMA
  return zod.union(live.map(pending => zod.strictObject({
    sessionId: zod.literal(String(pending.session.id)),
    questionId: zod.literal(String(pending.id)),
    answer: answerSchemaFor(pending.questions),
  })))
}

/**
 * The answer object as any ask reads it: item ids, chosen labels, and optional
 * text. It carries only what is true of every ask — {@link answerSchemaFor} adds
 * the ask-specific constraints on top — and it is also the `answer` field of
 * {@link NOTHING_ASKED_SCHEMA}, so both payload branches parse into one answer
 * representation.
 */
const ANSWER_OBJECT_SCHEMA = zod.object({
  answers: zod.array(zod.strictObject({
    id: zod.string().min(1),
    selected: zod.array(zod.string()),
    custom: zod.string().optional(),
  })),
})

/**
 * The payload schema when the ambient subject has no live ask: the fields are
 * read as written and one issue reports the actual problem, so an answer that
 * arrives after its question was resolved fails like every other invalid payload
 * instead of looking like a field error.
 */
const NOTHING_ASKED_SCHEMA = zod.strictObject({
  sessionId: zod.string(),
  questionId: zod.string().min(1),
  answer: ANSWER_OBJECT_SCHEMA,
}).refine(() => false, {
  path: ['questionId'],
  message: 'no question is waiting for an answer in this session and subject',
})

/**
 * The answer schema for one ask: one item per asked question, no item for
 * anything else, at most one label where the question is single-select, and every
 * item carrying an offered label or text. Complete by construction, so the asker
 * receives the whole batch answer it awaits.
 *
 * @param questions - the ask's questions, as the log recorded them.
 * @returns a schema accepting exactly the answers that ask can be given.
 */
function answerSchemaFor(questions: readonly AskUserQuestionItem[]) {
  const asked = new Map(questions.map(question => [question.id, question]))
  return ANSWER_OBJECT_SCHEMA.superRefine((answer, ctx) => {
    const answered = new Set<string>()
    for (const [index, item] of answer.answers.entries()) {
      const question = asked.get(item.id)
      if (question === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['answers', index, 'id'],
          message: `question ${JSON.stringify(item.id)} was not put by this ask`,
        })
        continue
      }
      if (answered.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['answers', index, 'id'],
          message: `question ${JSON.stringify(item.id)} is answered twice`,
        })
      }
      answered.add(item.id)
      const offered = (question.options ?? []).map(option => option.label)
      for (const [position, label] of item.selected.entries()) {
        if (!offered.includes(label)) {
          ctx.addIssue({
            code: 'custom',
            path: ['answers', index, 'selected', position],
            message: `question ${JSON.stringify(item.id)} offers no option ${JSON.stringify(label)}`,
          })
        }
      }
      if (question.multiSelect !== true && item.selected.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['answers', index, 'selected'],
          message: `question ${JSON.stringify(item.id)} accepts one option`,
        })
      }
      if (item.selected.length === 0 && (item.custom ?? '').trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['answers', index, 'custom'],
          message: `question ${JSON.stringify(item.id)} is answered with neither an offered option nor text`,
        })
      }
    }
    for (const id of asked.keys()) {
      if (!answered.has(id)) {
        ctx.addIssue({ code: 'custom', path: ['answers'], message: `question ${JSON.stringify(id)} is not answered` })
      }
    }
  })
}

/**
 * Normalize one parsed answer into the seam's own answer type.
 *
 * The parse accepts the wire's spelling of an absent text answer (`custom` absent
 * or undefined — the same JSON), while the domain type carries no `custom` field
 * unless the answer has text. The copy is also what the log snapshots, so no
 * caller-owned value reaches the session, and it gives the accepted answer one
 * form for both the resolution event and the waiting tool call.
 *
 * @param answer - the parsed answer payload.
 * @returns the answer in the domain's own representation.
 */
function toAnswer(answer: {
  answers: { id: string; selected: string[]; custom?: string | undefined }[]
}): AskUserQuestionAnswer {
  return {
    answers: answer.answers.map(item => ({
      id: item.id,
      selected: [...item.selected],
      ...item.custom === undefined ? {} : { custom: item.custom },
    })),
  }
}

export default TenantQuestionService
