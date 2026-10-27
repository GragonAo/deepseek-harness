/**
 * `sessions.delete` (hard deletion) at the Host gateway: the refusal fences
 * (running turn, subagent ownership, no persistence mounted), the
 * durability-then-accounting commit order, failure propagation, and the
 * process-lifetime tombstone that keeps a still-attached Session out of
 * `session.list` while its transcript read, turn admission, and re-creation
 * are all refused. The one surface still served through the tombstone — the
 * model directory and its selection — is pinned as a recorded residual at the
 * end rather than repaired here.
 *
 * Fixture style follows api-proxy-rename.spec.ts (real SessionStore +
 * AgentRegistry + structural Agent stubs) and api-proxy-cold.spec.ts
 * (`ctx.provide('sessionPersistence', …)` with structural verb spies).
 * Pipeline-registration evidence for this method lives beside its siblings
 * instead of here: fetch-carrier.spec.ts (handler ⇄ client round trip plus
 * UNARY_VALUE_SCHEMAS), client-handler.spec.ts (request-payload fence), and
 * rpc-schemas.spec.ts (request/value schema accept-reject).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`delete-${String(nextRpc++)}`), payload }
}

type Harness = {
  ctx: Context
  api: ReturnType<typeof createApiProxy>
  /** Every persistence/registry mutation in call order, as `verb:id` records. */
  order: string[]
  persistenceDelete: ReturnType<typeof vi.fn>
  forgetSession: ReturnType<typeof vi.fn>
}

/**
 * One provider route with one advertised model, so the model-directory methods
 * resolve against a real `LlmRuntime` instead of a structural `ctx.llm`.
 */
class CatalogueAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'm', name: 'M' }])
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The catalogue and selection paths never enter provider streaming.
  }
}

/**
 * Compose the gateway over real Session/Agent services plus structural
 * persistence and workspace-registry doubles. The doubles record their calls
 * into one ordered log, which is what the commit-order assertion reads.
 */
async function harness(options: {
  /** Session ids the persistence double reports as deleted in this process. */
  tombstones?: readonly string[]
  mountPersistence?: boolean
  mountWorkspaceRegistry?: boolean
  /** Mount a real LlmRuntime with one provider route serving provider `p`. */
  mountLlm?: boolean
  rejectDelete?: Error
} = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  if (options.mountLlm === true) {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['p'], new CatalogueAdapter())
  }

  const order: string[] = []
  const tombstones = new Set<string>(options.tombstones ?? [])
  const persistenceDelete = vi.fn(async (id: SessionId): Promise<void> => {
    order.push(`persistence.delete:${id}`)
    if (options.rejectDelete !== undefined) throw options.rejectDelete
  })
  const forgetSession = vi.fn(async (id: SessionId): Promise<void> => {
    order.push(`workspaceRegistry.forgetSession:${id}`)
  })
  if (options.mountPersistence !== false) {
    ctx.provide('sessionPersistence', {
      delete: persistenceDelete,
      isDeleted: (id: SessionId) => tombstones.has(String(id)),
      list: () => Promise.resolve([]),
    } as never)
  }
  if (options.mountWorkspaceRegistry !== false) {
    ctx.provide('workspaceRegistry', { forgetSession, archivedSessionIds: [] } as never)
  }
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, api, order, persistenceDelete, forgetSession }
}

/** Register one live agent over a real Session, optionally with a scripted turn state. */
function attach(
  ctx: Context,
  id: string,
  extra: { status?: string; meta?: Partial<SessionHeader>; followup?: () => void } = {},
): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj', ...extra.meta } })
  const agent = {
    id: session.id,
    session,
    status: extra.status ?? 'idle',
    ctx,
    // A live Agent always carries its pending-message queues; the model
    // selection reads them to admit an image for the next step.
    inbox: { nextTurn: [], nextStep: [] },
    ...extra.followup === undefined ? {} : { followup: extra.followup },
  } as unknown as Agent
  ctx.agents.register(agent)
  return session
}

describe('sessions.delete refusal fences', () => {
  it('refuses a running turn with agent-busy/TURN_RUNNING and touches nothing', async () => {
    const bench = await harness()
    attach(bench.ctx, 'session-busy', { status: 'running' })

    const response = await bench.api.sessions.delete(request({ sessionId: sid('session-busy') }))
    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'agent-busy',
        message: 'session "session-busy" has a running turn; cancel it before deleting',
        details: { reason: 'TURN_RUNNING' },
      },
    })
    expect(bench.persistenceDelete).not.toHaveBeenCalled()
    expect(bench.forgetSession).not.toHaveBeenCalled()
    expect(bench.order).toEqual([])
  })

  it('refuses an origin-marked subagent session with the shared ownership rejection', async () => {
    const bench = await harness()
    attach(bench.ctx, 'session-subagent', { meta: { origin: 'subagent' } })

    const response = await bench.api.sessions.delete(request({ sessionId: sid('session-subagent') }))
    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'agent-busy',
        message: 'session "session-subagent" is owned by subagent routing',
        details: { reason: 'use subagent delivery for this child session' },
      },
    })
    expect(bench.order).toEqual([])
  })

  it('refuses a live session a parent agent currently owns, even while idle', async () => {
    const bench = await harness()
    const parentSession = bench.ctx.sessions.create(sid('session-parent'), { meta: { cwd: '/proj' } })
    const parent = { id: parentSession.id, session: parentSession, status: 'idle', ctx: bench.ctx } as Agent
    bench.ctx.agents.register(parent)
    const childSession = bench.ctx.sessions.create(sid('session-child'), {
      meta: { cwd: '/proj', parentSession: parent.id },
    })
    const child = { id: childSession.id, session: childSession, status: 'idle', ctx: bench.ctx } as Agent
    bench.ctx.agents.enter(child, parent)

    const response = await bench.api.sessions.delete(request({ sessionId: childSession.id }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error).toMatchObject({
        code: 'agent-busy',
        details: { reason: 'use subagent delivery for this child session' },
      })
    }
    expect(bench.order).toEqual([])
  })

  it('answers internal naming the missing persistence when none is mounted', async () => {
    const bench = await harness({ mountPersistence: false })
    attach(bench.ctx, 'session-detached')

    const response = await bench.api.sessions.delete(request({ sessionId: sid('session-detached') }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('internal')
      expect(response.result.error.message).toMatch(/mounts no session persistence/)
      expect(response.result.error.details).toEqual({ sessionId: 'session-detached' })
    }
    expect(bench.forgetSession).not.toHaveBeenCalled()
    expect(bench.order).toEqual([])
  })
})

describe('sessions.delete commit order and failure propagation', () => {
  it('deletes the durable log first and forgets the registry account second', async () => {
    const bench = await harness()
    attach(bench.ctx, 'session-doomed')

    const response = await bench.api.sessions.delete(request({ sessionId: sid('session-doomed') }))
    expect(response.result).toEqual({ ok: true, value: { deleted: true } })
    expect(bench.order).toEqual([
      'persistence.delete:session-doomed',
      'workspaceRegistry.forgetSession:session-doomed',
    ])
  })

  it('propagates a durability failure without forgetting the registry account', async () => {
    const failure = new Error('durable remove failed')
    const bench = await harness({ rejectDelete: failure })
    attach(bench.ctx, 'session-stuck')
    const payload = { sessionId: sid('session-stuck') }

    // The impl does not throw business errors: a rejected durable delete is an
    // implementation failure, so it must reach the caller as such rather than
    // as an answer about the session's existence.
    await expect(bench.api.sessions.delete(request(payload))).rejects.toBe(failure)
    expect(bench.forgetSession).not.toHaveBeenCalled()
    expect(bench.order).toEqual(['persistence.delete:session-stuck'])

    // Through the carrier the same failure is a 500 crash, never a business
    // `session-not-found` the client would read as an answer.
    const carried = await toFetchHandler(bench.api).fetch(new Request('http://dsh.internal/api/session.delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r-delete', method: 'session.delete', payload }),
    }))
    expect(carried.status).toBe(500)
    const text = await carried.text()
    expect(text).toContain('handler failure')
    expect(text).not.toContain('session-not-found')
  })
})

describe('sessions.delete tombstone', () => {
  it('drops the still-attached deleted session from session.list and keeps its live neighbour', async () => {
    const bench = await harness({ tombstones: ['session-gone'] })
    attach(bench.ctx, 'session-gone')
    attach(bench.ctx, 'session-kept')
    // Both Sessions stay attached: a delete leaves the live Session in memory,
    // so the list is the source that would resurrect the removed identity.
    expect(bench.ctx.sessions.get(sid('session-gone'))).toBeDefined()
    expect(bench.ctx.sessions.get(sid('session-kept'))).toBeDefined()

    const response = await bench.api.sessions.list(request({}))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items.map(item => item.sessionId)).toEqual(['session-kept'])
  })

  /** Prove the tombstone is in effect in this very bench before reading through it. */
  async function expectTombstoned(bench: Harness, id: string): Promise<void> {
    const listed = await bench.api.sessions.list(request({}))
    expect(listed.result.ok).toBe(true)
    if (listed.result.ok) {
      expect(listed.result.value.items.map(item => item.sessionId)).not.toContain(id)
    }
    expect(bench.ctx.sessions.get(sid(id))).toBeDefined()
  }

  it('answers session-not-found for the transcript of a tombstoned attached session', async () => {
    const bench = await harness({ tombstones: ['session-gone'] })
    const session = attach(bench.ctx, 'session-gone')
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expectTombstoned(bench, 'session-gone')

    // The transcript read resolves through `historySourceFor`
    // (api-proxy.ts:1504), whose attached branch is skipped for a tombstoned
    // identity: the fall-through log read finds nothing, and the still-attached
    // Session's events are never served.
    const response = await bench.api.sessions.history(request({ sessionId: sid('session-gone') }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('session-not-found')
      expect(response.result.error.details).toEqual({ sessionId: 'session-gone' })
    }
  })

  it('closes the reads that resolve through readSessionState', async () => {
    const bench = await harness({ tombstones: ['session-gone'] })
    attach(bench.ctx, 'session-gone')
    await expectTombstoned(bench, 'session-gone')

    // The same tombstones, read by a method that goes through
    // `readSessionState` (api-proxy.ts:1467): its attached branch is skipped,
    // the log read finds nothing, and the answer is the documented not-found.
    const response = await bench.api.sessions.attachment(request({
      sessionId: sid('session-gone'),
      attachmentId: 'attachment-1' as never,
    }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('session-not-found')
  })

  it('refuses to re-create a tombstoned identity through ensureSession', async () => {
    const bench = await harness({ tombstones: ['session-gone'] })
    attach(bench.ctx, 'session-gone')

    const response = await bench.api.sessions.create(request({ sessionId: sid('session-gone'), cwd: '/proj' }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('internal')
      expect(response.result.error.message).toContain('failed to create session "session-gone"')
      expect(response.result.error.message).toContain('was deleted')
    }
  })

  it('refuses to start a turn for a tombstoned but still-attached session', async () => {
    const bench = await harness({ tombstones: ['session-gone'] })
    const followup = vi.fn()
    attach(bench.ctx, 'session-gone', { followup })
    await expectTombstoned(bench, 'session-gone')

    // `turnAgentFor` (api-proxy.ts:1835) refuses the tombstoned identity before
    // any agent lookup, so the live Session a delete left behind never receives
    // a prompt whose log write the tombstone would refuse.
    const response = await bench.api.sessions.prompt(request({
      sessionId: sid('session-gone'),
      mode: 'queue',
      content: [{ type: 'text', text: 'after the delete' }],
    }))
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('session-not-found')
      expect(response.result.error.message).toContain('was deleted')
      expect(response.result.error.details).toEqual({ sessionId: 'session-gone' })
    }
    expect(followup).not.toHaveBeenCalled()
  })

  it('still serves the model directory and accepts a selection for a tombstoned but still-attached session (recorded residual)', async () => {
    const bench = await harness({ tombstones: ['session-gone'], mountLlm: true })
    attach(bench.ctx, 'session-gone')
    await expectTombstoned(bench, 'session-gone')

    // Known residual, recorded rather than repaired: `models` (api-proxy.ts:2237)
    // and `selectModel` (api-proxy.ts:2247) resolve through `agentFor`, whose live
    // branch is the only one with no tombstone check, so both still answer while
    // the delete's tombstone is in effect and the Session is still attached.
    // Measured, not assumed: `selectModel` SUCCEEDS here too — it writes no session
    // event, it records the selection in memory through `selectionFor` (api-proxy.ts:2279
    // → model-selection.ts:1126) and only optionally calls `saveDefaultModelSelection`.
    // What the tombstone does refuse is the turn that would use the selection
    // (`turnAgentFor`), and a restart discards the unlogged choice.
    const catalogue = await bench.api.sessions.models(request({ sessionId: sid('session-gone') }))
    expect(catalogue.result).toEqual({
      ok: true,
      value: {
        current: { provider: 'p', model: 'm' },
        routable: true,
        groups: [{ id: 'p', name: 'p', models: [{ id: 'm', name: 'M' }] }],
        failures: [],
      },
    })

    const selected = await bench.api.sessions.selectModel(request({
      sessionId: sid('session-gone'),
      provider: 'p',
      model: 'm',
    }))
    expect(selected.result).toEqual({ ok: true, value: { selected: { provider: 'p', model: 'm' } } })

    // The residual changes nothing about the fence this suite owns: the same
    // session still refuses a turn, so the accepted selection can never run.
    const prompted = await bench.api.sessions.prompt(request({
      sessionId: sid('session-gone'),
      mode: 'queue',
      content: [{ type: 'text', text: 'after the delete' }],
    }))
    expect(prompted.result.ok).toBe(false)
    if (!prompted.result.ok) expect(prompted.result.error.code).toBe('session-not-found')
  })
})
