/**
 * Post-answer follow-up suggestions.
 *
 * When a top-level turn completes, this plugin asks an auxiliary model for a few
 * short questions the user is likely to ask next, then records the accepted ones
 * as a log-only `followup/suggested` event. Business surfaces fold that event
 * into the turn they already render, so no consumer parses the answer text for a
 * protocol tag, the main conversation prompt carries no output-format rule for
 * it, and a turn's suggestions survive reload because they are in the log.
 *
 * The suggestion call is auxiliary in the same sense as the session-title one: it
 * uses its own route, its own token and time budget, and never enters derived
 * history. Without a reachable route, or with an unparseable model reply, the
 * turn simply has no suggestions.
 * @module @deepseek-ai/dsh-session-followups
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Exact provider route used for one suggestion call. */
export interface FollowupModelRoute {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

/** Payload of the log-only `followup/suggested` event. */
export interface FollowupSuggestedEventData {
  /** Turn the questions follow. */
  readonly turn: number
  /** Accepted follow-up questions, in model order: trimmed, non-empty, unique. */
  readonly questions: string[]
}

/**
 * Payload of the log-only `followup/llm-request` event: the exact auxiliary
 * request, recorded before dispatch so the suggestion call is reconstructable
 * from the log alone.
 */
export interface FollowupLlmRequestEventData {
  /** Turn the request was generated for. */
  readonly turn: number
  /** Exact auxiliary LLM route. */
  readonly route: FollowupModelRoute
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Accepted follow-up questions for one completed turn. Log-only: never model-visible. */
    'followup/suggested': FollowupSuggestedEventData
    /** Log-only pre-dispatch record of one follow-up suggestion request. */
    'followup/llm-request': FollowupLlmRequestEventData
  }
}

/** Capability-owned timeout reason code for auxiliary suggestion requests. */
export const FOLLOWUP_TIMEOUT_CODE = 'SESSION_FOLLOWUP_TIMEOUT'

/** Required deployment policy for the suggestion generator. */
export interface Config {
  /**
   * Task framing the auxiliary model reads: what counts as a useful follow-up
   * question for this deployment, in this deployment's domain and language.
   */
  readonly instructions: string
  /** Maximum accepted questions per turn. */
  readonly maxQuestions: number
  /** Maximum UTF-8 bytes in the final framed user prompt; the answer is shortened to fit. */
  readonly maxInputBytes: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /**
   * Shortest final answer, in UTF-8 bytes, worth suggesting follow-ups for:
   * acknowledgement-only turns cost no auxiliary request.
   */
  readonly minAnswerBytes: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/** Validated immutable generator policy. */
export type ResolvedFollowupConfig = Readonly<Config>

/** One turn's material as the auxiliary model sees it. */
export interface FollowupTurnMaterial {
  /** The human prompt that opened the turn, trimmed; empty when the log carries none. */
  readonly question: string
  /** The turn's final answer text, trimmed. */
  readonly answer: string
  /** Distinct tool names the turn called, in first-call order. */
  readonly tools: string[]
}

/** Plugin name. */
export const name = 'session-followups'

/** Services required before the generator can run: the auxiliary model route registry. */
export const inject = ['llm']

/** Loader schema; this plugin supplies no defaults. */
export const Config: z<Config> = z.object({
  instructions: z.string().required(),
  maxQuestions: z.number().step(1).min(1).required(),
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  minAnswerBytes: z.number().step(1).min(0).required(),
  provider: z.string(),
  model: z.string(),
})

/** Configuration key set accepted by direct construction. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'instructions',
  'maxQuestions',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'minAnswerBytes',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(setting: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-followups: ${setting} must be a positive integer`)
  }
}

/**
 * Validate and freeze one untrusted deployment policy.
 * @param value - raw Loader or constructor configuration.
 * @returns the detached immutable policy.
 * @throws {Error} when a limit is out of range, the route pairing is incomplete, or a key is unknown.
 */
export function resolveFollowupConfig(value: Config): ResolvedFollowupConfig {
  const candidate: unknown = value
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-followups: configuration is required')
  }
  const settings = candidate as Config & Record<string, unknown>
  for (const key of Object.keys(settings)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-followups: unknown configuration key "${key}"`)
  }
  if (typeof settings.instructions !== 'string' || settings.instructions.trim().length === 0) {
    throw new Error('session-followups: instructions must be a non-empty string')
  }
  assertPositiveInteger('maxQuestions', settings.maxQuestions)
  assertPositiveInteger('maxInputBytes', settings.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', settings.maxOutputTokens)
  assertPositiveInteger('timeoutMs', settings.timeoutMs)
  if (!Number.isInteger(settings.minAnswerBytes) || settings.minAnswerBytes < 0) {
    throw new Error('session-followups: minAnswerBytes must be a non-negative integer')
  }
  const hasProvider = settings.provider !== undefined
  const hasModel = settings.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-followups: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof settings.provider !== 'string' || settings.provider.length === 0
      || typeof settings.model !== 'string' || settings.model.length === 0)) {
    throw new Error('session-followups: provider and model overrides must be non-empty strings')
  }
  const resolved: Config = {
    instructions: settings.instructions.trim(),
    maxQuestions: settings.maxQuestions,
    maxInputBytes: settings.maxInputBytes,
    maxOutputTokens: settings.maxOutputTokens,
    timeoutMs: settings.timeoutMs,
    minAnswerBytes: settings.minAnswerBytes,
    ...settings.provider === undefined ? {} : { provider: settings.provider },
    ...settings.model === undefined ? {} : { model: settings.model },
  }
  return deepFreeze(resolved)
}

/** Concatenate the user-visible text of one content block list. */
function textOfBlocks(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      default:
        // ContentBlockMap is merge-extensible: a block type this plugin does not
        // know is not user-visible text, so it contributes nothing here.
        break
    }
  }
  return text
}

/**
 * Collect one turn's question, final answer, and tool names from a session log.
 *
 * The answer is the highest-step assistant message of the turn: earlier steps are
 * pre-tool narration, and the last one is what the user actually reads. The
 * question is the newest human `user/message` inside the turn window, falling
 * back to the newest one before the turn closes — a queued prompt is appended
 * either before or after that turn's `turn/start`.
 *
 * @param events - session log to read; the log up to the turn's end is enough.
 * @param turn - the turn to describe.
 * @returns the turn's material; fields are empty when the log carries nothing usable.
 */
export function collectTurnMaterial(events: readonly SessionEvent[], turn: number): FollowupTurnMaterial {
  let answer = ''
  let answerStep = Number.NEGATIVE_INFINITY
  const tools: string[] = []
  let inWindow = false
  let questionInWindow: string | undefined
  let questionBeforeTurn: string | undefined
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user') break
        const text = textOfBlocks(event.data.content).trim()
        if (text.length === 0) break
        if (inWindow) questionInWindow = text
        else if (questionInWindow === undefined && questionBeforeTurn === undefined) {
          // Candidates recorded before the turn opens only matter until the turn
          // itself contributes one; keeping the newest avoids retaining them all.
          questionBeforeTurn = text
        } else if (questionInWindow === undefined) {
          questionBeforeTurn = text
        }
        break
      }
      case 'turn/start': {
        if (event.data.turn === turn) inWindow = true
        else if (inWindow) inWindow = false
        break
      }
      case 'turn/end': {
        if (event.data.turn === turn) inWindow = false
        break
      }
      case 'assistant/message': {
        if (event.data.turn !== turn) break
        if (event.data.step < answerStep) break
        answerStep = event.data.step
        answer = textOfBlocks(event.data.message.content).trim()
        break
      }
      case 'tool/call': {
        if (event.data.turn !== turn) break
        if (!tools.includes(event.data.name)) tools.push(event.data.name)
        break
      }
      default:
        // SessionEventMap is merge-extensible: unrelated events carry no turn
        // material this generator reads.
        break
    }
  }
  return {
    question: questionInWindow ?? questionBeforeTurn ?? '',
    answer,
    tools,
  }
}

/**
 * Frame one turn as the auxiliary model's user message.
 * @param material - the turn's question, answer, and tool names.
 * @returns JSON-framed text, so caller text cannot break a structural delimiter.
 */
function frameTurn(material: FollowupTurnMaterial): string {
  return `Suggest follow-up questions for this turn:\n${JSON.stringify(material)}`
}

/** UTF-8 byte length of a string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Replace one turn's answer, marking a shortened one with an ellipsis. */
function withAnswer(material: FollowupTurnMaterial, answer: string): FollowupTurnMaterial {
  if (answer.length === 0) return { ...material, answer: '' }
  return { ...material, answer: answer === material.answer ? answer : `${answer}…` }
}

/**
 * Shorten one answer until the framed turn fits the byte budget.
 *
 * The answer is the only unbounded field, and JSON escaping keeps the framed
 * length monotonic in its prefix, so the longest fitting prefix is found by
 * bisection rather than by trimming one character at a time.
 * @param material - the turn's complete material.
 * @param maxInputBytes - positive budget for the whole framed user message.
 * @returns material whose answer fits; the question and tool list are never shortened.
 */
function fitTurn(material: FollowupTurnMaterial, maxInputBytes: number): FollowupTurnMaterial {
  if (byteLength(frameTurn(material)) <= maxInputBytes) return material
  const characters = [...material.answer]
  let low = 0
  let high = characters.length
  let best = withAnswer(material, '')
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = withAnswer(material, characters.slice(0, middle).join(''))
    if (byteLength(frameTurn(candidate)) <= maxInputBytes) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

/**
 * Extract a JSON string array from one model reply.
 *
 * The reply is model output, so it is untrusted text: an array wrapped in a fence
 * or in prose is located by its outermost brackets, and entries that are not
 * usable questions (non-strings, blanks, repeats) are dropped instead of failing
 * the whole call.
 * @param text - the auxiliary model's reply.
 * @param maxQuestions - maximum accepted questions.
 * @returns up to `maxQuestions` trimmed, unique, non-empty questions; empty when none parse.
 */
export function parseFollowupQuestions(text: string, maxQuestions: number): string[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    // Model output carries no parse guarantee; an unparseable reply yields no questions.
    return []
  }
  if (!Array.isArray(parsed)) return []
  const questions: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const question = item.replace(/\s+/gu, ' ').trim()
    if (question.length === 0) continue
    if (questions.includes(question)) continue
    questions.push(question)
    if (questions.length >= maxQuestions) break
  }
  return questions
}

/** Translate a terminal finish reason into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('session-followups: suggestion output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('session-followups: suggestion model unexpectedly requested a tool')
    /* v8 ignore next 2 -- FinishReasonMap is merge-extensible: an adapter-added reason is a loud failure */
    default:
      return new Error(`session-followups: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** Resolve the explicit route pair or the route the session's last request used. */
function resolveRoute(config: ResolvedFollowupConfig, session: Session): FollowupModelRoute {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const header = session.requestHeader()
  if (header === undefined) {
    throw new Error('session-followups: no logged request route is available; configure provider and model together')
  }
  return { provider: header.config.provider, model: header.config.model }
}

/**
 * Test whether a session is a top-level conversation.
 *
 * A subagent child runs its own turns; spending a model call to suggest
 * follow-ups for a delegated turn serves no reader.
 * @param session - session whose header to inspect.
 * @returns whether the session is not a delegated child session.
 */
export function isTopLevelSession(session: Session): boolean {
  return session.header.parentSession === undefined && session.header.origin !== 'subagent'
}

/**
 * Generate and record one turn's follow-up suggestions.
 *
 * Appends nothing when the turn already carries suggestions, when its answer is
 * below `minAnswerBytes`, when the model reply yields no usable question, and
 * when the session log holds no route yet. A dispatch, transport, or parse
 * failure throws for the caller to contain: this runs on the post-commit
 * boundary where no failure can change the turn's outcome.
 * @param ctx - context exposing the auxiliary LLM service.
 * @param config - validated deployment policy.
 * @param session - live session the turn belongs to.
 * @param turn - completed turn to suggest follow-ups for.
 * @param signal - lifetime cancellation for the detached call.
 * @returns the accepted questions, or `undefined` when nothing was recorded.
 */
export async function generateSessionFollowups(
  ctx: Context,
  config: ResolvedFollowupConfig,
  session: Session,
  turn: number,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  signal.throwIfAborted()
  const alreadySuggested = session.events.some(
    event => event.type === 'followup/suggested' && event.data.turn === turn,
  )
  if (alreadySuggested) return undefined
  const material = collectTurnMaterial(session.events, turn)
  if (byteLength(material.answer) < config.minAnswerBytes) return undefined
  const framed = frameTurn(fitTurn(material, config.maxInputBytes))
  if (byteLength(framed) > config.maxInputBytes) {
    throw new Error(`session-followups: framed input is ${byteLength(framed)} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  const route = resolveRoute(config, session)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'plugin', plugin: 'dsh-session-followups' },
  })]
  const system = config.instructions
  using callDeadline = deadline(signal, config.timeoutMs, FOLLOWUP_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: 'session-followups',
    signal: callDeadline.signal,
  })
  session.append('followup/llm-request', {
    turn,
    route,
    system,
    messages,
    maxTokens: config.maxOutputTokens,
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-followups: suggestion output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const questions = parseFollowupQuestions(text, config.maxQuestions)
  if (questions.length === 0) {
    // 生成是尽力而为的，但「一个字都没解析出来」几乎总是预算或模型行为问题：
    // 推理型模型会把 maxOutputTokens 全花在推理上，finish 落到 length 而正文为空。
    ctx.logger.warn(`session "${session.id}": turn ${turn} yielded no follow-up questions (finish ${assembler.finish.kind}, ${byteLength(text)} text bytes)`)
    return undefined
  }
  session.append('followup/suggested', { turn, questions })
  return questions
}

/**
 * Register the follow-up suggestion generator.
 * @param ctx - context exposing the auxiliary LLM service.
 * @param config - required deployment policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveFollowupConfig(config)
  const lifetime = new AbortController()
  const inFlight = new Set<Promise<unknown>>()

  ctx.effect(() => async () => {
    lifetime.abort(new Error('session-followups disposed'))
    await Promise.allSettled([...inFlight])
    inFlight.clear()
  }, 'sessionFollowups lifecycle')

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (event.data.reason.kind !== 'completed') return
    if (!isTopLevelSession(session)) return
    const turn = event.data.turn
    // The `turn/end` append publication is still on the stack, and a session
    // cannot be appended re-entrantly: the suggestion run starts on the next
    // microtask, once the turn's commit has returned.
    const work = (async () => {
      await Promise.resolve()
      return generateSessionFollowups(ctx, resolved, session, turn, lifetime.signal)
    })().catch((error: unknown) => {
      ctx.logger.warn(`session "${session.id}": follow-up suggestion failed: ${String(error)}`)
      return undefined
    })
    inFlight.add(work)
    void work.finally(() => inFlight.delete(work))
  })
}
