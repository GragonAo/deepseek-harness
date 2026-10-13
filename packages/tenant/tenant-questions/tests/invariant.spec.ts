import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { TenantQuestionId } from '@deepseek-ai/dsh-tenant-questions'
import * as TenantQuestionInvariant from '@deepseek-ai/dsh-tenant-questions/invariant'

const CHOICE: AskUserQuestionItem = {
  id: 'q1',
  question: 'Proceed?',
  options: [{ label: 'yes' }, { label: 'no' }],
}

/** The answer relation accepted for {@link CHOICE}. */
const ANSWER = { answers: [{ id: 'q1', selected: ['yes'] }] }

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(TenantQuestionInvariant)
  return ctx
}

function startTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
}

describe('tenant question invariants', () => {
  it('accepts a paired ask and its answer', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = TenantQuestionId('ask-1')
    session.append('user-question/asked', { id, questions: [CHOICE] })
    session.append('user-question/decided', { id, outcome: 'answered', answer: ANSWER })
  })

  it('accepts a withdrawn ask without an answer', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    // An unrelated event inside the turn is not the pair's business.
    session.append('step/start', { turn: 1, step: 1 })
    const id = TenantQuestionId('ask-1')
    session.append('user-question/asked', { id, questions: [CHOICE] })
    session.append('user-question/decided', { id, outcome: 'timed-out' })
  })

  it('rebuilds an open ask from an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    const id = TenantQuestionId('ask-resume')
    session.append('user-question/asked', { id, questions: [CHOICE] })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(TenantQuestionInvariant)

    expect(() => session.append('user-question/decided', { id, outcome: 'cancelled' })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session first observed through publication', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('bare-question-session'))
    const id = TenantQuestionId('bare-ask')
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'user-question/asked', seq: 1, time: 1, data: { id, questions: [CHOICE] },
      })
      ctx.emit('session/event', session, {
        type: 'user-question/decided', seq: 2, time: 2, data: { id, outcome: 'answered', answer: ANSWER },
      })
    }).not.toThrow()
  })

  it('rejects audit events outside any open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const id = TenantQuestionId('ask-1')

    expect(() => session.append('user-question/asked', { id, questions: [CHOICE] }))
      .toThrow(/outside any open turn/)
    expect(() => session.append('user-question/decided', { id, outcome: 'cancelled' }))
      .toThrow(/outside any open turn/)
  })

  it('rejects an unenclosed audit event when replaying an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('user-question/asked', { id: TenantQuestionId('ask-replay'), questions: [CHOICE] })
    await ctx.plugin(InvariantRegistry)

    await expect(ctx.plugin(TenantQuestionInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it('rejects an ask that puts no question', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)

    expect(() => session.append('user-question/asked', { id: TenantQuestionId('ask-1'), questions: [] }))
      .toThrow(/put no question/)
  })

  it('rejects an ask that repeats a question id', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)

    expect(() => session.append('user-question/asked', {
      id: TenantQuestionId('ask-1'),
      questions: [CHOICE, { ...CHOICE, question: 'Again?' }],
    })).toThrow(/repeats question id/)
  })

  it('rejects a second open ask under one id', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = TenantQuestionId('ask-1')
    session.append('user-question/asked', { id, questions: [CHOICE] })

    expect(() => session.append('user-question/asked', { id, questions: [CHOICE] }))
      .toThrow(/repeated open ask id/)
  })

  it('rejects a resolution with no matching ask and an unknown outcome', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = TenantQuestionId('ask-1')
    session.append('user-question/asked', { id, questions: [CHOICE] })

    expect(() => session.append('user-question/decided', { id: TenantQuestionId('missing'), outcome: 'answered', answer: ANSWER }))
      .toThrow(/no matching user-question\/asked/)
    expect(() => session.append('user-question/decided', { id, outcome: 'maybe' as never }))
      .toThrow(/unknown outcome/)
    expect(() => session.append('user-question/decided', { id, outcome: 'answered' }))
      .toThrow(/must carry an answer exactly when it was answered/)
    expect(() => session.append('user-question/decided', { id, outcome: 'cancelled', answer: ANSWER }))
      .toThrow(/must carry an answer exactly when it was answered/)
    expect(() => session.append('user-question/decided', {
      id, outcome: 'answered', answer: { answers: [{ id: 'other', selected: ['yes'] }] },
    })).toThrow(/which the ask did not put/)
    expect(() => session.append('user-question/decided', {
      id, outcome: 'answered', answer: { answers: [{ id: 'q1', selected: ['yes'] }, { id: 'q1', selected: ['no'] }] },
    })).toThrow(/twice/)
    expect(() => session.append('user-question/decided', { id, outcome: 'answered', answer: { answers: [] } }))
      .toThrow(/leaves question "q1" unanswered/)
  })

  it('accepts a logged answer that ignores the order the questions were put in', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const id = TenantQuestionId('ask-2')
    const questions: AskUserQuestionItem[] = [CHOICE, { id: 'q2', question: 'When?' }]
    session.append('user-question/asked', { id, questions })

    expect(() => session.append('user-question/decided', {
      id,
      outcome: 'answered',
      answer: { answers: [{ id: 'q2', selected: [], custom: 'soon' }, { id: 'q1', selected: ['no'] }] },
    })).not.toThrow()
    // The pair is consumed: a further resolution of the same id is unpaired.
    expect(() => session.append('user-question/decided', { id, outcome: 'cancelled' }))
      .toThrow(/no matching user-question\/asked/)
  })

  it('validates a published event before it reaches any listener', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    const event: SessionEvent = {
      type: 'user-question/decided',
      seq: 99,
      time: 0,
      data: { id: TenantQuestionId('never-asked'), outcome: 'cancelled' },
    } as SessionEvent

    expect(() => ctx.emit('session/event', session, event)).toThrow(/no matching user-question\/asked/)
  })
})
