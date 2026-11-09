import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { CallId, LlmAdapter, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  apply,
  collectTurnMaterial,
  FOLLOWUP_TIMEOUT_CODE,
  generateSessionFollowups,
  inject,
  isTopLevelSession,
  name,
  parseFollowupQuestions,
  resolveFollowupConfig,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onDispatch?.()
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected a follow-up request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise exact AbortSignal.reason propagation
        reject(signal.reason)
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

class FailingAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    throw new Error('adapter exploded')
  }
}

const QUESTIONS = ['这些异常账户集中在哪个网点？', '近三个月还有哪些类似客户？', '能否按交易金额排序？']

/** A stop-terminated text reply carrying `text`. */
function textScript(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const POLICY: Config = {
  instructions: '  Ask three follow-ups.  ',
  maxQuestions: 3,
  maxInputBytes: 4_096,
  maxOutputTokens: 64,
  timeoutMs: 1_000,
  minAnswerBytes: 1,
}

/** A bare context with the session store mounted, for log-shape tests. */
async function store(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

let nextSession = 0

interface SeedOptions {
  readonly answer?: string
  readonly humanQuestion?: string
  readonly queuedBeforeTurn?: boolean
  readonly turnReason?: 'completed' | 'aborted'
  readonly withHeader?: boolean
  readonly closeTurn?: boolean
}

/** Create one session whose turn 1 carries `options.answer` as its final answer. */
function seed(ctx: Context, options: SeedOptions = {}): Session {
  const session = ctx.sessions.create(SessionId(`followups-${++nextSession}`))
  if (options.withHeader !== false) {
    session.append('request/header', {
      header: { config: { provider: 'route-provider', model: 'route-model' } },
      reason: 'initial',
    })
  }
  const human = createUserMessage({
    content: [{ type: 'text', text: options.humanQuestion ?? '本月哪些账户交易异常？' }],
    source: { kind: 'user' },
  })
  if (options.queuedBeforeTurn === true) session.append('user/message', human, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  if (options.queuedBeforeTurn !== true) session.append('user/message', human, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('tool/call', { turn: 1, step: 0, callId: CallId('call-1'), name: 'query_transactions', arguments: '{}' })
  session.append('tool/call', { turn: 1, step: 0, callId: CallId('call-2'), name: 'query_transactions', arguments: '{}' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: options.answer ?? '共有 3 个账户存在异常交易。' }],
      source: { provider: 'route-provider', model: 'route-model' },
    }),
  }, { surfaceOp: 'append' })
  if (options.turnReason === 'aborted') {
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  } else if (options.closeTurn !== false) {
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  return session
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
}

/** Mount the session store, LLM runtime, and one scripted adapter on route `route-provider`. */
async function harness(
  script: readonly StreamChunk[] = textScript(JSON.stringify(QUESTIONS)),
  adapter: ScriptedAdapter = new ScriptedAdapter(script),
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['route-provider'], adapter)
  return { ctx, adapter }
}

function routed(overrides: Partial<Config> = {}): ReturnType<typeof resolveFollowupConfig> {
  return resolveFollowupConfig({ ...POLICY, ...overrides })
}

describe('resolveFollowupConfig', () => {
  it('trims the task framing and accepts a paired route override', () => {
    const resolved = resolveFollowupConfig({ ...POLICY, provider: 'p', model: 'm' })
    expect(resolved.instructions).toBe('Ask three follow-ups.')
    expect(resolved.provider).toBe('p')
    expect(resolved.model).toBe('m')
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it.each([
    ['a non-object policy', null as unknown as Config, 'configuration is required'],
    ['an unknown key', { ...POLICY, extra: 1 } as unknown as Config, 'unknown configuration key "extra"'],
    ['blank framing', { ...POLICY, instructions: '   ' }, 'instructions must be a non-empty string'],
    ['a fractional question cap', { ...POLICY, maxQuestions: 2.5 }, 'maxQuestions must be a positive integer'],
    ['a zero input budget', { ...POLICY, maxInputBytes: 0 }, 'maxInputBytes must be a positive integer'],
    ['a zero output cap', { ...POLICY, maxOutputTokens: 0 }, 'maxOutputTokens must be a positive integer'],
    ['a zero deadline', { ...POLICY, timeoutMs: 0 }, 'timeoutMs must be a positive integer'],
    ['a negative answer floor', { ...POLICY, minAnswerBytes: -1 }, 'minAnswerBytes must be a non-negative integer'],
    ['half a route pair', { ...POLICY, provider: 'p' }, 'provider and model must be supplied together'],
    ['an empty provider', { ...POLICY, provider: '', model: 'm' }, 'provider and model overrides must be non-empty strings'],
    ['an empty model', { ...POLICY, provider: 'p', model: '' }, 'provider and model overrides must be non-empty strings'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => resolveFollowupConfig(value)).toThrow(message)
  })

  it('accepts a zero answer floor', () => {
    expect(resolveFollowupConfig({ ...POLICY, minAnswerBytes: 0 }).minAnswerBytes).toBe(0)
  })
})

describe('collectTurnMaterial', () => {
  it('takes the last-step answer, the human question, and each distinct tool name', async () => {
    const ctx = await store()
    const session = seed(ctx, {})
    expect(collectTurnMaterial(session.events, 1)).toEqual({
      question: '本月哪些账户交易异常？',
      answer: '共有 3 个账户存在异常交易。',
      tools: ['query_transactions'],
    })
  })

  it('finds a queued prompt appended before the turn opened', async () => {
    const ctx = await store()
    const session = seed(ctx, { queuedBeforeTurn: true })
    expect(collectTurnMaterial(session.events, 1).question).toBe('本月哪些账户交易异常？')
  })

  it('keeps the newest question before the turn when the turn contributes none', async () => {
    const ctx = await store()
    const session = ctx.sessions.create(SessionId('followups-no-question'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '第一个问题' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '第二个问题' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '答案' }],
        source: { provider: 'route-provider', model: 'route-model' },
      }),
    }, { surfaceOp: 'append' })
    expect(collectTurnMaterial(session.events, 1)).toEqual({ question: '第二个问题', answer: '答案', tools: [] })
  })

  it('ignores plugin-sourced, blank, non-text, and unrelated-turn events', async () => {
    const ctx = await store()
    const session = ctx.sessions.create(SessionId('followups-noise'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '   ' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 2 })
    session.append('assistant/message', {
      turn: 2,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '其他轮次的答案' }],
        source: { provider: 'route-provider', model: 'route-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 2, step: 0, callId: CallId('call-9'), name: 'other_tool', arguments: '{}' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    session.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'thinking' }],
        source: { provider: 'route-provider', model: 'route-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '本轮答案' }],
        source: { provider: 'route-provider', model: 'route-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '更早步骤的旁白' }],
        source: { provider: 'route-provider', model: 'route-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(collectTurnMaterial(session.events, 1)).toEqual({ question: '', answer: '本轮答案', tools: [] })
  })
})

describe('parseFollowupQuestions', () => {
  it('reads a fenced array wrapped in prose', () => {
    const fenced = ['Here you go:', '```json', JSON.stringify(QUESTIONS), '```'].join('\n')
    expect(parseFollowupQuestions(fenced, 3)).toEqual(QUESTIONS)
  })

  it('normalizes whitespace, drops blanks, non-strings, and repeats, and clamps the cap', () => {
    const reply = JSON.stringify(['  第一个\n  问题  ', '', '   ', 7, '第一个 问题', '第二个问题', '第三个问题'])
    expect(parseFollowupQuestions(reply, 2)).toEqual(['第一个 问题', '第二个问题'])
  })

  it.each([
    ['no array', 'there are no questions here'],
    ['an empty bracket pair', 'nothing but []'],
    ['invalid JSON', '[1, 2,,]'],
    ['a JSON object', '{"a": 1}'],
  ])('returns no questions for %s', (_label, reply) => {
    expect(parseFollowupQuestions(reply, 3)).toEqual([])
  })
})

describe('isTopLevelSession', () => {
  it('accepts a plain conversation and rejects delegated children', async () => {
    const { ctx } = await harness()
    expect(isTopLevelSession(ctx.sessions.create(SessionId('plain')))).toBe(true)
    const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: SessionId('plain') } })
    expect(isTopLevelSession(child)).toBe(false)
    const subagent = ctx.sessions.create(SessionId('subagent'), { meta: { origin: 'subagent' } })
    expect(isTopLevelSession(subagent)).toBe(false)
  })
})

describe('generateSessionFollowups', () => {
  it('logs the exact request before dispatch and records the accepted questions', async () => {
    let requestWasLoggedAtDispatch = false
    const probe: { session?: Session } = {}
    const adapterWithProbe = new ScriptedAdapter(textScript(JSON.stringify(QUESTIONS)), () => {
      requestWasLoggedAtDispatch = probe.session?.events.some(event => event.type === 'followup/llm-request') ?? false
    })
    const { ctx } = await harness(textScript(JSON.stringify(QUESTIONS)), adapterWithProbe)
    const session = seed(ctx)
    probe.session = session
    const questions = await generateSessionFollowups(ctx, routed(), session, 1, new AbortController().signal)

    expect(questions).toEqual(QUESTIONS)
    expect(requestWasLoggedAtDispatch).toBe(true)
    const request = adapterWithProbe.requests[0]
    expect(request).toMatchObject({
      provider: 'route-provider',
      model: 'route-model',
      system: 'Ask three follow-ups.',
      maxTokens: 64,
      purpose: 'session-followups',
      sessionId: session.id,
    })
    expect(Object.isFrozen(request)).toBe(true)

    const logged = session.events.filter(event => event.type === 'followup/llm-request')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({
      turn: 1,
      route: { provider: 'route-provider', model: 'route-model' },
      maxTokens: 64,
    })
    const suggested = session.events.filter(event => event.type === 'followup/suggested')
    expect(suggested).toHaveLength(1)
    expect(suggested[0]?.data).toEqual({ turn: 1, questions: QUESTIONS })
  })

  it('prefers an explicitly configured route', async () => {
    const { ctx } = await harness()
    const adapter = new ScriptedAdapter(textScript(JSON.stringify(QUESTIONS)))
    ctx.llm.registerAdapter(['pinned-provider'], adapter)
    const session = seed(ctx, { withHeader: false })
    await generateSessionFollowups(
      ctx,
      routed({ provider: 'pinned-provider', model: 'pinned-model' }),
      session,
      1,
      new AbortController().signal,
    )
    expect(adapter.requests[0]).toMatchObject({ provider: 'pinned-provider', model: 'pinned-model' })
  })

  it('refuses to guess a route when the log holds none', async () => {
    const { ctx } = await harness()
    const session = seed(ctx, { withHeader: false })
    await expect(generateSessionFollowups(ctx, routed(), session, 1, new AbortController().signal))
      .rejects.toThrow('no logged request route is available')
  })

  it('skips a turn whose answer is below the floor', async () => {
    const { ctx, adapter } = await harness()
    const session = seed(ctx, { answer: '好' })
    await expect(generateSessionFollowups(ctx, routed({ minAnswerBytes: 8 }), session, 1, new AbortController().signal))
      .resolves.toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    expect(session.events.some(event => event.type === 'followup/llm-request')).toBe(false)
  })

  it('skips a turn that already carries suggestions', async () => {
    const { ctx, adapter } = await harness()
    const session = seed(ctx)
    session.append('followup/suggested', { turn: 1, questions: ['已有追问'] })
    await expect(generateSessionFollowups(ctx, routed(), session, 1, new AbortController().signal))
      .resolves.toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    expect(session.events.filter(event => event.type === 'followup/suggested')).toHaveLength(1)
  })

  it('records nothing when the reply carries no parsable question', async () => {
    const { ctx } = await harness(textScript('I cannot help with that.'))
    const session = seed(ctx)
    await expect(generateSessionFollowups(ctx, routed(), session, 1, new AbortController().signal))
      .resolves.toBeUndefined()
    expect(session.events.some(event => event.type === 'followup/suggested')).toBe(false)
  })

  it('rejects a reply containing a tool call', async () => {
    const script: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: JSON.stringify(QUESTIONS) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { ctx } = await harness(script)
    const session = seed(ctx)
    await expect(generateSessionFollowups(ctx, routed(), session, 1, new AbortController().signal))
      .rejects.toThrow('suggestion output must contain text only')
    expect(session.events.some(event => event.type === 'followup/suggested')).toBe(false)
  })

  it.each([
    ['max-tokens', { kind: 'max-tokens' } as const, 'reached maxOutputTokens'],
    ['tool-calls', { kind: 'tool-calls' } as const, 'unexpectedly requested a tool'],
    ['error', { kind: 'error', failure: { code: 'PROVIDER', message: 'provider failed' } } as const, 'provider failed'],
    ['aborted', { kind: 'aborted', failure: { code: 'DEADLINE', message: 'deadline exceeded' } } as const, 'deadline exceeded'],
    ['an unknown reason', { kind: 'mystery' } as unknown as { kind: 'stop' }, 'session-followups: unsupported finish reason'],
  ])('surfaces a %s finish', async (_label, reason, message) => {
    const script: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: JSON.stringify(QUESTIONS) },
      { type: 'finish', reason: reason as never },
    ]
    const { ctx } = await harness(script)
    const session = seed(ctx)
    await expect(generateSessionFollowups(ctx, routed(), session, 1, new AbortController().signal))
      .rejects.toThrow(message)
  })

  it('shortens the answer to the input budget and never exceeds it', async () => {
    const adapter = new ScriptedAdapter(textScript(JSON.stringify(QUESTIONS)))
    const { ctx } = await harness(textScript(JSON.stringify(QUESTIONS)), adapter)
    const session = seed(ctx, { answer: '异'.repeat(200) })
    await generateSessionFollowups(ctx, routed({ maxInputBytes: 200 }), session, 1, new AbortController().signal)
    const prompt = adapter.requests[0]?.messages[0]
    const text = prompt?.content.find(block => block.type === 'text')
    expect(text?.type).toBe('text')
    const framed = text?.type === 'text' ? text.text : ''
    expect(Buffer.byteLength(framed, 'utf8')).toBeLessThanOrEqual(200)
    const payload = JSON.parse(framed.slice(framed.indexOf('{'))) as { answer: string }
    expect(payload.answer.endsWith('…')).toBe(true)
    expect(payload.answer.length).toBeLessThan(200)
  })

  it('fails loudly when even an empty answer cannot fit the budget', async () => {
    const { ctx } = await harness()
    const session = seed(ctx)
    await expect(generateSessionFollowups(ctx, routed({ maxInputBytes: 8 }), session, 1, new AbortController().signal))
      .rejects.toThrow('exceeding maxInputBytes 8')
  })

  it('honours an already-aborted lifetime', async () => {
    const { ctx, adapter } = await harness()
    const session = seed(ctx)
    const controller = new AbortController()
    controller.abort(new Error('disposed'))
    await expect(generateSessionFollowups(ctx, routed(), session, 1, controller.signal)).rejects.toThrow('disposed')
    expect(adapter.requests).toHaveLength(0)
  })

  it('fails the call at the deadline', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['route-provider'], new CooperativeAdapter())
    const session = seed(ctx)
    await expect(generateSessionFollowups(ctx, routed({ timeoutMs: 5 }), session, 1, new AbortController().signal))
      .rejects.toMatchObject({ code: FOLLOWUP_TIMEOUT_CODE })
  })
})

describe('apply', () => {
  it('suggests follow-ups after a completed top-level turn', async () => {
    const { ctx } = await harness()
    await ctx.plugin({ inject: [...inject], apply }, POLICY)
    const session = seed(ctx, { closeTurn: false })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      expect(session.events.some(event => event.type === 'followup/suggested')).toBe(true)
    }, { timeout: 2_000 })
  })

  it('ignores turns that did not complete and delegated children', async () => {
    const { ctx, adapter } = await harness()
    await ctx.plugin({ inject: [...inject], apply }, POLICY)
    seed(ctx, { turnReason: 'aborted' })
    const child = ctx.sessions.create(SessionId('apply-child'), { meta: { parentSession: SessionId('parent') } })
    child.append('request/header', {
      header: { config: { provider: 'route-provider', model: 'route-model' } },
      reason: 'initial',
    })
    child.append('turn/start', { turn: 1 })
    child.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '子会话答案' }],
        source: { provider: 'route-provider', model: 'route-model' },
      }),
    }, { surfaceOp: 'append' })
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(adapter.requests).toHaveLength(0)
  })

  it('logs a warning instead of failing the turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['route-provider'], new FailingAdapter())
    const warnings: string[] = []
    const logger = ctx.logger
    vi.spyOn(logger, 'warn').mockImplementation(((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }) as never)
    await ctx.plugin({ inject: [...inject], apply }, POLICY)
    const session = seed(ctx, { closeTurn: false })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      expect(warnings.some(line => line.includes('follow-up suggestion failed'))).toBe(true)
    }, { timeout: 2_000 })
  })

  it('aborts in-flight work when the plugin is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['route-provider'], new CooperativeAdapter())
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const fiber = ctx.plugin({ inject: [...inject], apply }, POLICY)
    await fiber.await()
    const session = seed(ctx, { closeTurn: false })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 10))
    await fiber.dispose()
    expect(session.events.some(event => event.type === 'followup/suggested')).toBe(false)
  })
})

describe('plugin identity', () => {
  it('declares the loader-facing name and required service', () => {
    expect(name).toBe('session-followups')
    expect(inject).toEqual(['llm'])
  })
})
