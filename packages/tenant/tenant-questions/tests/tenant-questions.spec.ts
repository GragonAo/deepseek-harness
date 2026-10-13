import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ZodError } from 'zod'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import TenantQuestionService, {
  TENANT_QUESTION_METHODS,
  type TenantPendingQuestion,
} from '@deepseek-ai/dsh-tenant-questions'
import * as TenantQuestionInvariant from '@deepseek-ai/dsh-tenant-questions/invariant'

const TENANT: Tenant = {
  id: TenantId('tenant-a'),
  name: 'Tenant A',
  dataRoot: '/data/tenant-a',
  workspaceRoot: '/workspace/tenant-a',
}

/** Run one call as the authenticated (tenant, subject) the business surface proves. */
function asSubject<T>(fn: () => T, subject = 'subject-1', tenant: Tenant = TENANT): T {
  return runWithTenant(tenant, () => runWithUser(UserId(subject), fn))
}

const CHOICE: AskUserQuestionItem = {
  id: 'deploy-target',
  question: 'Which target should the deploy use?',
  detail: 'Both are currently green.',
  options: [{ label: 'staging' }, { label: 'production' }],
}

interface Harness {
  ctx: Context
  session: Session
  agent: Agent
  /** The ambient subject's live asks. */
  asks: () => TenantPendingQuestion[]
}

/** Boot the real session store, seam, and channel over one open turn. */
async function harness(config: { answerTimeoutMs?: number; seamTimeoutMs?: number; invariant?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (config.invariant === true) {
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(TenantQuestionInvariant)
  }
  await ctx.plugin(UserQuestionService, { answerTimeoutMs: config.seamTimeoutMs ?? 600_000 })
  await ctx.plugin(TenantQuestionService, config.answerTimeoutMs === undefined ? {} : { answerTimeoutMs: config.answerTimeoutMs })
  const session = ctx.sessions.create()
  const agent = { id: session.id, session } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  session.append('turn/start', { turn: 1 })
  // A question is asked mid-step, so the turn is not the log's last event.
  session.append('step/start', { turn: 1, step: 1 })
  return { ctx, session, agent, asks: () => asSubject(() => ctx.tenantQuestions.list()) }
}

/** Wait for the ask to reach the channel and return the live asks. */
async function waitForAsks(harness: Harness, count = 1): Promise<TenantPendingQuestion[]> {
  return await vi.waitFor(() => {
    const asks = harness.asks()
    expect(asks).toHaveLength(count)
    return asks
  })
}

/** Ask inside the tenant scope; the caller owns observing the returned promise. */
function ask(harness: Harness, questions: AskUserQuestionItem[], signal?: AbortSignal) {
  return asSubject(() => harness.ctx.userQuestions.ask({
    questions,
    agent: harness.agent,
    ...signal === undefined ? {} : { signal },
  }))
}

/** Answer through the business plane as the ambient subject. */
function answer(harness: Harness, payload: unknown): Promise<unknown> {
  return asSubject(() => harness.ctx.tenantQuestions.answer(payload))
}

/** The one logged event of a type, or undefined. */
function logged(session: Session, type: 'user-question/asked' | 'user-question/decided') {
  return session.events.find(event => event.type === type)
}

describe('TenantQuestionService', () => {
  it('records the ask as a session event and answers it through the business plane', async () => {
    const h = await harness()
    const pending = ask(h, [CHOICE])
    const [live] = await waitForAsks(h)
    const asked = logged(h.session, 'user-question/asked')

    expect(asked?.data).toEqual({ id: live?.id, questions: [CHOICE] })
    expect(live).toMatchObject({
      sessionId: h.session.id,
      questions: [CHOICE],
    })
    expect(live?.expiresAtMs).toBeGreaterThan(Date.now())

    await expect(answer(h, {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    })).resolves.toEqual({ questionId: live?.id, sessionId: h.session.id })

    await expect(pending).resolves.toEqual({ answers: [{ id: 'deploy-target', selected: ['staging'] }] })
    expect(logged(h.session, 'user-question/decided')?.data).toEqual({
      id: live?.id,
      outcome: 'answered',
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    })
    expect(h.asks()).toEqual([])
  })

  it('accepts free text for a question that offers no options', async () => {
    const h = await harness()
    const pending = ask(h, [{ id: 'note', question: 'Anything to add?' }])
    const [live] = await waitForAsks(h)

    await answer(h, {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'note', selected: [], custom: 'ship it on Friday' }] },
    })

    await expect(pending).resolves.toEqual({
      answers: [{ id: 'note', selected: [], custom: 'ship it on Friday' }],
    })
  })

  it('carries one answer item per question of a multi-question ask', async () => {
    const h = await harness()
    const questions: AskUserQuestionItem[] = [CHOICE, { id: 'window', question: 'When?', multiSelect: true, options: [{ label: 'now' }, { label: 'tonight' }] }]
    const pending = ask(h, questions)
    const [live] = await waitForAsks(h)

    await answer(h, {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: {
        answers: [
          { id: 'window', selected: ['now', 'tonight'] },
          { id: 'deploy-target', selected: ['production'] },
        ],
      },
    })

    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'window', selected: ['now', 'tonight'] },
        { id: 'deploy-target', selected: ['production'] },
      ],
    })
  })

  it('keeps one subject out of another subject’s list and answers', async () => {
    const h = await harness()
    const pending = ask(h, [CHOICE])
    const [live] = await waitForAsks(h)
    const payload = {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    }
    const anotherTenant: Tenant = { ...TENANT, id: TenantId('tenant-b') }

    expect(asSubject(() => h.ctx.tenantQuestions.list(), 'subject-2')).toEqual([])
    expect(asSubject(() => h.ctx.tenantQuestions.list(), 'subject-1', anotherTenant)).toEqual([])
    // Another subject — and the same subject under another tenant — may not
    // answer what they were not asked.
    await expect(asSubject(() => h.ctx.tenantQuestions.answer(payload), 'subject-2'))
      .rejects.toThrow(/no question is waiting/)
    await expect(asSubject(() => h.ctx.tenantQuestions.answer(payload), 'subject-1', anotherTenant))
      .rejects.toThrow(/no question is waiting/)
    await expect(answer(h, payload)).resolves.toBeDefined()
    await expect(pending).resolves.toBeDefined()
  })

  it('rejects an answer that does not address a live ask of this subject', async () => {
    const h = await harness()
    const first = ask(h, [CHOICE])
    const [live] = await waitForAsks(h)
    const sessionId = String(h.session.id)

    // Each payload is a way an answer can miss the ask it names: another
    // session's id, an id nobody is waiting on, an option never offered, two
    // options on a single-select question, a missing or duplicated or unknown
    // item, an item with neither an option nor text, an unknown field, and a
    // payload that is not an object at all.
    const refused: unknown[] = [
      { sessionId: 'some-other-session', questionId: live?.id, answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] } },
      { sessionId, questionId: 'no-such-question', answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] } },
      { sessionId, questionId: live?.id, answer: { answers: [{ id: 'deploy-target', selected: ['canary'] }] } },
      { sessionId, questionId: live?.id, answer: { answers: [{ id: 'deploy-target', selected: ['staging', 'production'] }] } },
      { sessionId, questionId: live?.id, answer: { answers: [] } },
      { sessionId, questionId: live?.id, answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }, { id: 'deploy-target', selected: ['staging'] }] } },
      { sessionId, questionId: live?.id, answer: { answers: [{ id: 'something-else', selected: ['staging'] }] } },
      { sessionId, questionId: live?.id, answer: { answers: [{ id: 'deploy-target', selected: [] }] } },
      { sessionId, questionId: live?.id, answer: { answers: [{ id: 'deploy-target', selected: ['staging'], extra: 1 }] } },
      { sessionId, questionId: live?.id, answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] }, extra: 1 },
      'not-a-payload',
    ]

    for (const payload of refused) {
      await expect(answer(h, payload)).rejects.toBeInstanceOf(ZodError)
    }
    // The refusals left the ask waiting: a business client can correct its payload.
    expect(h.asks()).toHaveLength(1)
    await expect(answer(h, {
      sessionId,
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    })).resolves.toBeDefined()
    await expect(first).resolves.toBeDefined()
  })

  it('rejects any answer once nothing waits, naming the real problem', async () => {
    const h = await harness()

    await expect(answer(h, {
      sessionId: String(h.session.id),
      questionId: 'stale',
      answer: { answers: [] },
    })).rejects.toThrow(/no question is waiting for an answer in this session and subject/)
  })

  it('rejects a second answer to a claimed ask', async () => {
    const h = await harness()
    const pending = ask(h, [CHOICE])
    const [live] = await waitForAsks(h)
    const payload = {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    }

    await expect(answer(h, payload)).resolves.toBeDefined()
    await expect(pending).resolves.toBeDefined()
    await expect(answer(h, payload)).rejects.toThrow(/no question is waiting/)
    // The claimed ask is settled once, so its resolution is logged once.
    expect(h.session.events.filter(event => event.type === 'user-question/decided')).toHaveLength(1)
  })

  it('releases the waiting turn when the resolution cannot be logged', async () => {
    const h = await harness({ invariant: true })
    const pending = ask(h, [CHOICE])
    const [live] = await waitForAsks(h)
    // The turn ends between the ask and the answer, so the audit invariant refuses
    // the resolution: the channel must not leave the tool call waiting for a
    // decision the log will never carry.
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const rejection = await answer(h, {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    }).then(() => undefined, (error: unknown) => error)

    expect(rejection).toBeInstanceOf(Error)
    expect(String(rejection)).toMatch(/outside any open turn/)
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/outside any open turn/) as unknown as string })
    expect(logged(h.session, 'user-question/decided')).toBeUndefined()
    expect(h.asks()).toEqual([])
  })

  it('releases the deadline with the log’s refusal when the resolution cannot be logged', async () => {
    const h = await harness({ answerTimeoutMs: 20, invariant: true })
    const pending = ask(h, [CHOICE])
    await waitForAsks(h)
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/outside any open turn/) as unknown as string })
    expect(logged(h.session, 'user-question/decided')).toBeUndefined()
    expect(h.asks()).toEqual([])
  })

  it('reports the timeout to the model and records it', async () => {
    const h = await harness({ answerTimeoutMs: 20 })
    const pending = ask(h, [CHOICE])

    const rejection = await pending.then(() => undefined, (error: unknown) => error)
    expect(rejection).toMatchObject({ name: 'UserQuestionError', code: 'ANSWER_TIMEOUT' })
    // The message is the model's whole basis for changing course.
    expect((rejection as Error).message).toContain('not answered within 20ms')
    expect(logged(h.session, 'user-question/decided')?.data).toMatchObject({ outcome: 'timed-out' })
    expect(h.asks()).toEqual([])
  })

  it('records a withdrawn ask and rejects with the abort', async () => {
    const h = await harness()
    const controller = new AbortController()
    const pending = ask(h, [CHOICE], controller.signal)
    await waitForAsks(h)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(logged(h.session, 'user-question/decided')?.data).toMatchObject({ outcome: 'cancelled' })
  })

  it('records nothing for a signal that was already aborted', async () => {
    const h = await harness()
    const controller = new AbortController()
    controller.abort()

    await expect(ask(h, [CHOICE], controller.signal))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(logged(h.session, 'user-question/asked')).toBeUndefined()
    expect(h.asks()).toEqual([])
  })

  it('leaves the seam’s own deadline to the seam, recording the ask as withdrawn', async () => {
    // The configured window must stay below the seam's: reaching the seam's
    // deadline aborts the ask, so the model sees the seam's reason instead of
    // this channel's timeout.
    const h = await harness({ answerTimeoutMs: 600_000, seamTimeoutMs: 20 })

    await expect(ask(h, [CHOICE])).rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_ANSWER' })
    expect(logged(h.session, 'user-question/decided')?.data).toMatchObject({ outcome: 'cancelled' })
  })

  it('keeps the deadline from settling an ask the business answered', async () => {
    const h = await harness({ answerTimeoutMs: 30 })
    const pending = ask(h, [CHOICE])
    const [live] = await waitForAsks(h)

    await answer(h, {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    })
    await new Promise(resolve => setTimeout(resolve, 60))

    await expect(pending).resolves.toEqual({ answers: [{ id: 'deploy-target', selected: ['staging'] }] })
    expect(h.session.events.filter(event => event.type === 'user-question/decided')).toHaveLength(1)
  })

  it('refuses an ask with no tenant and subject in scope', async () => {
    const h = await harness()

    await expect(h.ctx.userQuestions.ask({ questions: [CHOICE], agent: h.agent }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_QUESTION_SCOPE' })
    expect(logged(h.session, 'user-question/asked')).toBeUndefined()
  })

  it('serves a channel built without the plugin schema', async () => {
    // Every loaded composition resolves `answerTimeoutMs` through the Config
    // schema's default; a direct construction bypasses that schema, so the `??`
    // narrowing the optional type is the only deadline such a channel has (the
    // approval package's precedent for covering a defaulted Config field).
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService, { answerTimeoutMs: 600_000 })
    const service = new TenantQuestionService(ctx, {})
    const session = ctx.sessions.create()
    const agent = { id: session.id, session } as unknown as Agent
    ctx.agents.enter(agent, undefined)
    session.append('turn/start', { turn: 1 })
    const pending = asSubject(() => ctx.userQuestions.ask({ questions: [CHOICE], agent }))
    const [live] = await vi.waitFor(() => {
      const asks = asSubject(() => service.list())
      expect(asks).toHaveLength(1)
      return asks
    })

    await asSubject(() => service.answer({
      sessionId: String(session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['staging'] }] },
    }))

    await expect(pending).resolves.toEqual({ answers: [{ id: 'deploy-target', selected: ['staging'] }] })
  })

  it('refuses an ask outside an open turn', async () => {
    const h = await harness()
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await expect(ask(h, [CHOICE]))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_OPEN_TURN' })
    expect(logged(h.session, 'user-question/asked')).toBeUndefined()
  })

  it('refuses an ask from a session whose log carries no turn boundary', async () => {
    const h = await harness()
    const bare = h.ctx.sessions.create()
    const agent = { id: bare.id, session: bare } as unknown as Agent
    h.ctx.agents.enter(agent, undefined)

    await expect(asSubject(() => h.ctx.userQuestions.ask({ questions: [CHOICE], agent })))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_OPEN_TURN' })
    expect(logged(bare, 'user-question/asked')).toBeUndefined()
  })

  it('refuses an ask whose question ids repeat', async () => {
    const h = await harness()

    await expect(ask(h, [CHOICE, { ...CHOICE, question: 'Again?' }]))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'DUPLICATE_QUESTION_ID' })
    expect(logged(h.session, 'user-question/asked')).toBeUndefined()
  })

  it('refuses an agentless ask', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(TenantQuestionService)

    await expect(asSubject(() => ctx.userQuestions.ask({ questions: [CHOICE] })))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_MISSING_AGENT' })
  })

  it('releases pending asks and stops providing the seam on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const fork = await ctx.plugin(TenantQuestionService)
    const session = ctx.sessions.create()
    const agent = { id: session.id, session } as unknown as Agent
    ctx.agents.enter(agent, undefined)
    session.append('turn/start', { turn: 1 })
    const pending = asSubject(() => ctx.userQuestions.ask({ questions: [CHOICE], agent }))
    await waitForAsks({ ctx, session, agent, asks: () => asSubject(() => ctx.tenantQuestions.list()) })

    await fork.dispose()

    await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    await expect(asSubject(() => ctx.userQuestions.ask({ questions: [CHOICE], agent })))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
  })

  it('serves both business-plane methods through its own wire table', async () => {
    const h = await harness()
    const pending = ask(h, [CHOICE])
    const [live] = await waitForAsks(h)
    const service = h.ctx.tenantQuestions

    expect([...TENANT_QUESTION_METHODS.keys()]).toEqual(['tenantQuestion.list', 'tenantQuestion.answer'])
    await expect(asSubject(() => TENANT_QUESTION_METHODS.get('tenantQuestion.list')?.(service, {})))
      .resolves.toEqual([live])
    await expect(asSubject(() => TENANT_QUESTION_METHODS.get('tenantQuestion.answer')?.(service, {
      sessionId: String(h.session.id),
      questionId: live?.id,
      answer: { answers: [{ id: 'deploy-target', selected: ['production'] }] },
    }))).resolves.toEqual({ questionId: live?.id, sessionId: h.session.id })
    await expect(pending).resolves.toBeDefined()
  })
})
