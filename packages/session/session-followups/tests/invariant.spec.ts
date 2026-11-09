import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { FollowupLlmRequestEventData } from '../src/index.ts'
import * as FollowupInvariant from '../src/invariant.ts'

const PACKAGE = '@deepseek-ai/dsh-session-followups'

/** Invariant rejection shape every failing case below must produce. */
const REJECTION = {
  code: 'INVARIANT',
  packageName: PACKAGE,
} as const satisfies Partial<InvariantError>

let nextSession = 0

/** A context with the session store and the invariant companion mounted. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(FollowupInvariant)
  return ctx
}

/** A fresh session on `ctx`. */
function session(ctx: Context) {
  return ctx.sessions.create(SessionId(`followups-invariant-${++nextSession}`))
}

const REQUEST: FollowupLlmRequestEventData = {
  turn: 1,
  route: { provider: 'route-provider', model: 'route-model' },
  system: 'Ask three follow-ups.',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'framed' }], source: { kind: 'plugin', plugin: 'test' } })],
  maxTokens: 64,
}

describe('invariant companion', () => {
  it('accounts for package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(FollowupInvariant).await()).resolves.toBeDefined()
  })

  it('accepts a well-formed request and batch', async () => {
    const ctx = await setup()
    const target = session(ctx)
    expect(() => {
      target.append('followup/llm-request', { ...REQUEST })
      target.append('followup/suggested', { turn: 1, questions: ['第一个问题', '第二个问题'] })
    }).not.toThrow()
    expect(target.events.map(event => event.type)).toEqual(['followup/llm-request', 'followup/suggested'])
  })

  it.each([
    ['a non-object payload', null, 'must carry an object payload'],
    ['a negative turn', { turn: -1, questions: ['q'] }, 'turn must be a non-negative integer'],
    ['a fractional turn', { turn: 1.5, questions: ['q'] }, 'turn must be a non-negative integer'],
    ['no questions', { turn: 1, questions: [] }, 'at least one question'],
    ['a padded question', { turn: 1, questions: [' q '] }, 'already trimmed'],
    ['a blank question', { turn: 1, questions: [''] }, 'non-empty and already trimmed'],
    ['a non-string question', { turn: 1, questions: [7] }, 'non-empty and already trimmed'],
    ['a repeated question', { turn: 1, questions: ['q', 'q'] }, 'repeats question'],
  ])('rejects a batch with %s', async (_label, payload, message) => {
    const ctx = await setup()
    const target = session(ctx)
    expect(() => {
      target.append('followup/suggested', payload as never)
    }).toThrow(expect.objectContaining(REJECTION))
    expect(() => {
      target.append('followup/suggested', payload as never)
    }).toThrow(message)
    expect(target.events).toEqual([])
  })

  it.each([
    ['a non-object payload', null, 'must carry an object payload'],
    ['a negative turn', { ...REQUEST, turn: -1 }, 'turn must be a non-negative integer'],
    ['no route', { ...REQUEST, route: null }, 'must record a route object'],
    ['an empty provider', { ...REQUEST, route: { provider: '', model: 'm' } }, 'route.provider must be a non-empty string'],
    ['an empty model', { ...REQUEST, route: { provider: 'p', model: '' } }, 'route.model must be a non-empty string'],
    ['a blank system prompt', { ...REQUEST, system: '   ' }, 'system must be a non-empty string'],
    ['no messages', { ...REQUEST, messages: [] }, 'must record at least one message'],
    ['a zero token cap', { ...REQUEST, maxTokens: 0 }, 'maxTokens must be a positive integer'],
    ['a fractional token cap', { ...REQUEST, maxTokens: 1.5 }, 'maxTokens must be a positive integer'],
  ])('rejects a request with %s', async (_label, payload, message) => {
    const ctx = await setup()
    const target = session(ctx)
    expect(() => {
      target.append('followup/llm-request', payload as never)
    }).toThrow(expect.objectContaining(REJECTION))
    expect(() => {
      target.append('followup/llm-request', payload as never)
    }).toThrow(message)
  })

  it('rejects a log that already holds a malformed batch when the companion mounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const target = session(ctx)
    target.append('followup/suggested', { turn: 1, questions: [' q '] } as never)
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(FollowupInvariant).await()).rejects.toThrow(expect.objectContaining(REJECTION))
  })

  it('ignores events it does not own', async () => {
    const ctx = await setup()
    const target = session(ctx)
    expect(() => {
      target.append('turn/start', { turn: 1 })
    }).not.toThrow()
    expect(target.events).toHaveLength(1)
  })
})
