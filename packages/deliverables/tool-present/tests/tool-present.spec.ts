import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-present` on a real `ToolRuntime`
 * and invokes the registered `present` tool through `ctx.tools.execute`, with a
 * fake parent Agent carrying a real `Session` — so the declaration the tool makes
 * is observable on a genuine session log.
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(retainTurns = 50): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, { retainTurns })
  return ctx
}

let callCounter = 0
function callPresent(
  ctx: Context,
  args: unknown,
  over: { agent?: Agent | undefined } = {},
) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'present',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('dsh-tool-present', () => {
  it('registers a `present` tool whose schema is an array of {path, description}', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'present')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['files'])
    const files = props.files as { type: string; items?: { properties?: Record<string, unknown> } }
    expect(files.type).toBe('array')
    expect(Object.keys(files.items?.properties ?? {}).sort()).toEqual(['description', 'path'])
  })

  it('appends a deliverables/presented event attributed to the open turn', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    agent.session.append('turn/start', { turn: 3 })
    const result = await callPresent(ctx, { files: [{ path: 'report.md', description: '成稿' }] }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected present success')
    expect(result.value).toEqual({ turn: 3, files: [{ path: 'report.md', description: '成稿' }] })
    expect(text(result)).toContain('- report.md — 成稿')

    const event = agent.session.events.findLast(entry => entry.type === 'deliverables/presented')!
    expect(event.data.turn).toBe(3)
    expect(event.data.files).toEqual([{ path: 'report.md', description: '成稿' }])
    expect(event.data.callId).toMatch(/^call-/)
  })

  it('attributes a later declaration to its own turn, leaving the earlier one alone', async () => {
    const ctx = await setup()
    const agent = agentWithSession('turns')
    agent.session.append('turn/start', { turn: 1 })
    await callPresent(ctx, { files: [{ path: 'a.md' }] }, { agent })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.session.append('turn/start', { turn: 2 })
    await callPresent(ctx, { files: [{ path: 'b.md' }] }, { agent })
    const declared = agent.session.events
      .filter(entry => entry.type === 'deliverables/presented')
      .map(entry => entry.data.turn)
    expect(declared).toEqual([1, 2])
  })

  it('rejects a declaration made outside a running turn', async () => {
    const ctx = await setup()
    const result = await callPresent(ctx, { files: [{ path: 'a.md' }] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present must be called while a turn is running')
  })

  it('rejects a repeated path, a blank path, and an empty description', async () => {
    const ctx = await setup()
    const agent = agentWithSession('invalid')
    agent.session.append('turn/start', { turn: 1 })
    const duplicate = await callPresent(ctx, { files: [{ path: 'a.md' }, { path: 'a.md' }] }, { agent })
    expect(duplicate.isError).toBe(true)
    expect(text(duplicate)).toContain('is declared twice')
    const blank = await callPresent(ctx, { files: [{ path: '   ' }] }, { agent })
    expect(blank.isError).toBe(true)
    expect(text(blank)).toContain('non-empty')
    const empty = await callPresent(ctx, { files: [{ path: 'a.md', description: '  ' }] }, { agent })
    expect(empty.isError).toBe(true)
    expect(text(empty)).toContain('empty description')
    expect(agent.session.events.some(entry => entry.type === 'deliverables/presented')).toBe(false)
  })

  it('rejects a caller without an owning agent session', async () => {
    const ctx = await setup()
    const result = await callPresent(ctx, { files: [{ path: 'a.md' }] }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('present requires an owning agent session')
  })
})
