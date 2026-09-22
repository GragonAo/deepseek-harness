/**
 * Service Definition for the user-questions capability seam (`ctx.userQuestions`): a UI-backed service for
 * pausing an agent tool call until the human answers a question. The model-
 * facing tool lives in `@deepseek-ai/dsh-tool-ask-user`; UI packages provide
 * the single active provider.
 *
 * @module @deepseek-ai/dsh-user-questions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

import type { AskUserQuestionAnswer, AskUserQuestionItem } from './types.ts'

export type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionIntent, AskUserQuestionItem,
  AskUserQuestionOption,
} from './types.ts'

/** Request for a human answer. */
export interface AskUserQuestionRequest {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Exact live calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}

/** UI-side provider for user questions. */
export interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/**
 * Service configuration.
 *
 * The answer deadline is deployment-varying rather than fixed: an interactive UI
 * whose human may step away needs minutes, while a headless API deployment that
 * has no reachable answerer at all should fail fast and let the agent proceed.
 */
export interface Config {
  /** Milliseconds an unanswered question may stay pending before `ask()` rejects. */
  answerTimeoutMs?: number
}

const DEFAULT_ANSWER_TIMEOUT_MS = 600_000

/** Stable error taxonomy for user-questions failures. */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

/** `ctx.userQuestions`: one active UI provider plus an `ask()` API. */
export class UserQuestionService extends Service {
  static Config: z<Config> = z.object({
    answerTimeoutMs: z.natural().min(1).default(DEFAULT_ANSWER_TIMEOUT_MS),
  })

  private provider: UserQuestionProvider | undefined
  private readonly answerTimeoutMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'userQuestions')
    this.answerTimeoutMs = config.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
  }

  /**
   * Register the UI provider. Only one provider may be active in a context.
   *
   * @param provider UI-side implementation that collects answers.
   * @returns Disposer that unregisters this provider.
   */
  registerProvider(provider: UserQuestionProvider): () => void {
    const dispose = this.ctx.effect(function* (this: UserQuestionService) {
      if (this.provider !== undefined) {
        throw new UserQuestionError('a user-questions provider is already registered', 'DUPLICATE_PROVIDER')
      }
      this.provider = provider
      yield () => {
        this.provider = undefined
      }
    }.bind(this), 'userInteraction.registerProvider()')
    return () => void dispose()
  }

  /**
   * Ask the active UI provider and wait for the user's answer.
   *
   * When a caller supplies an agent, human interaction is valid only for the
   * exact live runtime root. Runtime ownership, not durable session lineage,
   * decides this boundary: an owned child has no human answerer and would
   * block forever, while a lineage-bearing session resumed as a new runtime
   * root may ask normally.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `CALLER_NOT_LIVE` when a supplied
   *   agent is not the registry's exact live instance, or `DELEGATED_CALLER`
   *   when that live agent is owned by another agent.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    if (request.questions.length === 0) {
      throw new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const agent = request.agent
    if (agent !== undefined) {
      const agents = this.ctx.get('agents')
      if (agents === undefined || agents.get(agent.id) !== agent) {
        throw new UserQuestionError(
          'human interaction requires the exact live calling agent when an agent is supplied',
          'CALLER_NOT_LIVE')
      }
      if (!agents.roots().includes(agent)) {
        throw new UserQuestionError(
          'human interaction is unavailable while the calling agent is owned by another live agent; '
          + "include the unresolved question or decision in the child agent's final result",
          'DELEGATED_CALLER')
      }
    }
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
    if (this.provider === undefined) {
      throw new UserQuestionError('no user-questions provider is registered', 'NO_PROVIDER')
    }
    return await this.askBounded(this.provider, request)
  }

  /**
   * Ask the provider under the configured deadline.
   *
   * A provider whose answerer never arrives — no connected client, an unreachable
   * UI — would otherwise leave the call pending forever, holding the tool call and
   * with it the whole turn open. Nothing then closes that turn: the loop writes no
   * `turn/end`, so a later process exit tears the log and the persistence layer
   * repairs it into a silent `interrupted` turn, discarding the work and telling
   * nobody why. Reaching the deadline releases the provider through its own abort
   * signal and rejects `NO_ANSWER`, which the tool turns into a failure result the
   * agent can act on.
   *
   * @param provider - the registered provider to ask.
   * @param request - the caller's questions, agent, and signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `NO_ANSWER` when the deadline passes first.
   */
  private async askBounded(
    provider: UserQuestionProvider,
    request: AskUserQuestionRequest,
  ): Promise<AskUserQuestionAnswer> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.answerTimeoutMs)
    timer.unref?.()
    const signal = request.signal === undefined
      ? controller.signal
      : AbortSignal.any([request.signal, controller.signal])
    try {
      const pending = provider.ask({ ...request, signal })
      // The race settles on whichever comes first; the losing promise may still
      // reject afterwards, and an unobserved rejection would crash the process.
      void pending.catch(() => {})
      const expired = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new UserQuestionError(
            `no answer arrived within ${String(this.answerTimeoutMs)}ms`, 'NO_ANSWER'))
        }, { once: true })
      })
      return await Promise.race([pending, expired])
    } finally {
      clearTimeout(timer)
    }
  }
}

export default UserQuestionService
