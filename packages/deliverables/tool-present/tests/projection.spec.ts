/**
 * The `deliverables` projection unit: mounting tool-present beside the registry
 * serves the per-turn delivered files on the history tail page with a consistent
 * asOfSeq (= last event seq); a turn's later declarations merge into that turn;
 * dedupe and retention follow the documented rules; a composition without the
 * package has no `deliverables` key; unmounting the package removes it (HMR safety).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import * as ToolPresent from '@deepseek-ai/dsh-tool-present'
import type { DeliverablesState } from '@deepseek-ai/dsh-tool-present/types'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`present-proj-${String(nextRpc++)}`), payload }
}

interface Bench {
  ctx: Context
  session: Session
  tailProjections(): Promise<{ asOfSeq: number; values: Record<string, unknown> } | undefined>
}

async function harness(withPresentTool: boolean, retainTurns = 50): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withPresentTool) await ctx.plugin(ToolPresent, { retainTurns })
  const session = ctx.sessions.create()
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return {
    ctx,
    session,
    async tailProjections() {
      const response = await api.sessions.history(request({ sessionId: session.id }))
      if (!response.result.ok) throw new Error('history failed')
      return response.result.value.projections
    },
  }
}

/** One paginable message so the tail page is non-degenerate. */
function seedMessage(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Append one declaration the way the tool does. */
function declare(session: Session, turn: number, files: { path: string; description?: string }[]): void {
  session.append('deliverables/presented', { turn, callId: CallId(`call-${turn}-${files.length}`), files })
}

describe('deliverables projection provider', () => {
  it('serves an empty turn list before the first declaration', async () => {
    const bench = await harness(true)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections?.values.deliverables).toEqual({ turns: [] })
    expect(projections?.asOfSeq).toBe(bench.session.seq - 1)
  })

  it('groups declarations by turn and keeps declaration order', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    declare(session, 1, [{ path: '/sessions/s/报告.md', description: '成稿' }])
    declare(session, 1, [{ path: '/sessions/s/台账.csv' }])
    declare(session, 2, [{ path: '/sessions/s/附件.docx' }])
    const state = (await bench.tailProjections())?.values.deliverables as DeliverablesState
    expect(state.turns).toEqual([
      {
        turn: 1,
        files: [
          { path: '/sessions/s/报告.md', description: '成稿' },
          { path: '/sessions/s/台账.csv' },
        ],
      },
      { turn: 2, files: [{ path: '/sessions/s/附件.docx' }] },
    ])
  })

  it('keeps one entry per path inside a turn', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    declare(session, 1, [{ path: '/sessions/s/a.md' }])
    declare(session, 1, [{ path: '/sessions/s/a.md', description: 'again' }])
    const state = (await bench.tailProjections())?.values.deliverables as DeliverablesState
    expect(state.turns).toEqual([{ turn: 1, files: [{ path: '/sessions/s/a.md' }] }])
  })

  it('retains only the most recent turns', async () => {
    const bench = await harness(true, 2)
    const session = bench.session
    seedMessage(session)
    declare(session, 1, [{ path: '/sessions/s/one.md' }])
    declare(session, 2, [{ path: '/sessions/s/two.md' }])
    declare(session, 3, [{ path: '/sessions/s/three.md' }])
    const state = (await bench.tailProjections())?.values.deliverables as DeliverablesState
    expect(state.turns.map(entry => entry.turn)).toEqual([2, 3])
  })

  it('has no deliverables key when the package is not composed', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections).toBeDefined()
    expect('deliverables' in (projections?.values ?? {})).toBe(false)
  })

  it('drops the key when the package fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const fiber = await bench.ctx.plugin(ToolPresent, { retainTurns: 50 })
    expect((await bench.tailProjections())?.values.deliverables).toEqual({ turns: [] })
    await fiber.dispose()
    expect('deliverables' in ((await bench.tailProjections())?.values ?? {})).toBe(false)
  })
})
