import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type {
  ContainerCommandResult,
  ContainerPtyOptions,
  ContainerPtyOutcome,
  ContainerPtyRead,
  ContainerPtySession,
} from '@deepseek-ai/dsh-container'
import TerminalSessionService, { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { TerminalSendOperation } from '@deepseek-ai/dsh-terminal'
import * as TerminalContainer from '../src/index.ts'

/** Configuration that settles a send quickly, so the timing rules stay testable. */
const FAST = { pollIntervalMs: 5, idleSilenceMs: 15, timeoutMs: 400 }

function fakeAgent(ctx: Context, rawId: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

/** One interactive session the sandbox would own; the test drives both sides of it. */
class FakePty implements ContainerPtySession {
  readonly pid = 4242
  readonly done: Promise<ContainerPtyOutcome>
  readonly writes: string[] = []
  readonly signals: string[] = []
  readonly closeReasons: string[] = []
  foregroundValue: number | undefined = 4242
  foregroundFailure: Error | undefined

  private settleDone!: (outcome: ContainerPtyOutcome) => void
  private output = ''
  private dropped = false

  constructor() {
    this.done = new Promise((resolve) => { this.settleDone = resolve })
  }

  read(): ContainerPtyRead {
    const data = this.output
    const truncated = this.dropped
    this.output = ''
    this.dropped = false
    return { data, truncated }
  }

  async write(data: string): Promise<void> {
    this.writes.push(data)
  }

  async foreground(): Promise<{ pgid: number } | undefined> {
    if (this.foregroundFailure !== undefined) throw this.foregroundFailure
    return this.foregroundValue === undefined ? undefined : { pgid: this.foregroundValue }
  }

  async signal(signal: string): Promise<number> {
    this.signals.push(signal)
    return 4242
  }

  async close(reason: string): Promise<void> {
    this.closeReasons.push(reason)
    this.exit(0)
  }

  /** Feed output to the session, as the shell inside the sandbox would. */
  push(data: string): void {
    this.output += data
  }

  /** End the in-container command. */
  exit(exitCode: number | null): void {
    this.settleDone({ exitCode, signal: null })
  }
}

class FakeRuntime extends ContainerRuntime {
  readonly opens: ContainerPtyOptions[] = []
  readonly ptys: FakePty[] = []
  failWith: Error | undefined

  async exec(): Promise<ContainerCommandResult> {
    throw new Error('FakeRuntime: the terminal backend never runs a one-shot exec')
  }

  async openPty(options: ContainerPtyOptions): Promise<ContainerPtySession> {
    this.opens.push(options)
    if (this.failWith !== undefined) throw this.failWith
    const pty = new FakePty()
    this.ptys.push(pty)
    return pty
  }
}

async function setup(config: TerminalContainer.Config = FAST) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(FakeRuntime, undefined)
  await ctx.plugin(TerminalContainer, config)
  // The installed runtime is this harness's fake; the assertions read its records.
  return { ctx, runtime: ctx.get('containerRuntime') as unknown as FakeRuntime, agent: fakeAgent(ctx, 'owner-1') }
}

/** Open one terminal session through the registry, as a tool consumer would. */
async function open(config: TerminalContainer.Config = FAST, request: { cwd?: string } = {}) {
  const harness = await setup(config)
  const spawned = await harness.ctx.terminals.spawn(harness.agent, { type: config.backendType ?? 'shell', ...request })
  const id = TerminalSessionId(spawned.sessionId)
  const pty = harness.runtime.ptys[0] as FakePty
  return { ...harness, spawned, id, pty }
}

describe('terminal-container backend', () => {
  it('registers its type and opens an interactive shell in the tenant sandbox', async () => {
    const { ctx, runtime, spawned } = await open()
    expect(ctx.terminals.listBackends()).toEqual(['shell'])
    expect(spawned).toMatchObject({ type: 'shell', pid: 4242, status: { kind: 'running' } })

    const options = runtime.opens[0] as ContainerPtyOptions
    expect(options.command).toBe('/bin/sh')
    expect(options.args?.slice(0, 1)).toEqual(['-c'])
    const [payload] = options.args?.slice(1) as string[]
    expect(payload).toContain("cd '/workspace' ||")
    expect(payload).toContain("TERM='dumb'")
    expect(payload).toContain("PAGER='cat'")
    expect(payload).toContain("DSH_PTY_SESSION_ID='pty-1'")
    expect(payload).toContain('exec "$0" "$@"')
    expect(options.args?.slice(2)).toEqual(['/bin/bash', '--noprofile', '--norc', '-i'])
    expect(options).toMatchObject({ rows: 40, cols: 160, maxOutputBytes: 4 * 1024 * 1024, disposeGraceMs: 3_000 })
  })

  it('takes a session working directory from the spawn request and quotes it for the shell', async () => {
    const { runtime } = await open(FAST, { cwd: "/tmp/it's here" })
    const [payload] = (runtime.opens[0] as ContainerPtyOptions).args?.slice(1) as string[]
    expect(payload).toContain("cd '/tmp/it'\\''s here' ||")
  })

  it('exposes the configured shell and bounds to the container session', async () => {
    const { runtime } = await open({
      ...FAST,
      backendType: 'sandbox',
      shellPath: '/usr/bin/bash',
      shellArgs: ['-i'],
      rows: 24,
      cols: 80,
      scrollbackMaxBytes: 4_096,
      readMaxBytes: 1_024,
      disposeGraceMs: 500,
    })
    const options = runtime.opens[0] as ContainerPtyOptions
    expect(options.args?.slice(2)).toEqual(['/usr/bin/bash', '-i'])
    expect(options).toMatchObject({ rows: 24, cols: 80, maxOutputBytes: 4_096, disposeGraceMs: 500 })
  })

  it('adopts output produced before publication as the session banner', async () => {
    class GreetingRuntime extends FakeRuntime {
      override async openPty(options: ContainerPtyOptions): Promise<ContainerPtySession> {
        const pty = await super.openPty(options)
        ;(this.ptys[0] as FakePty).push('bash-5.2# ')
        return pty
      }
    }
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(GreetingRuntime, undefined)
    await ctx.plugin(TerminalContainer, FAST)
    const spawned = await ctx.terminals.spawn(fakeAgent(ctx, 'owner-banner'), { type: 'shell' })
    expect(spawned.motd).toBe('bash-5.2# ')
  })

  it('writes submitted text with Enter and settles as stdin_read on a quiet terminal', async () => {
    const { ctx, agent, id, pty } = await open()
    const operation = ctx.terminals.startSend(agent, id, { text: 'echo hi', submit: true })
    expect(pty.writes).toEqual(['echo hi\n'])
    pty.push('hi\r\nbash-5.2# ')
    expect(await operation.done).toMatchObject({
      waitReason: 'stdin_read',
      viewport: 'hi\r\nbash-5.2# ',
      sessionStatus: { kind: 'running' },
      truncated: false,
    })
  })

  it('writes incomplete input verbatim when the caller does not submit', async () => {
    const { ctx, agent, id, pty } = await open()
    const operation = ctx.terminals.startSend(agent, id, { text: 'print(', submit: false })
    expect(pty.writes).toEqual(['print('])
    await operation.done
  })

  it('settles inferred_idle when no process group holds the terminal', async () => {
    const { ctx, agent, id, pty } = await open()
    pty.foregroundValue = undefined
    const operation = ctx.terminals.startSend(agent, id, { text: 'true', submit: true })
    expect((await operation.done).waitReason).toBe('inferred_idle')
  })

  it('settles session_exit when the in-container command ends', async () => {
    const { ctx, agent, id, pty } = await open()
    const operation = ctx.terminals.startSend(agent, id, { text: 'exit', submit: true })
    pty.exit(0)
    await expect(operation.done).resolves.toMatchObject({
      waitReason: 'session_exit',
      sessionStatus: { kind: 'exited', exitCode: 0, signal: null },
    })
  })

  it('answers a send on an already ended session without waiting', async () => {
    const { ctx, agent, id, pty } = await open()
    pty.exit(3)
    await new Promise(resolve => setTimeout(resolve, 10))
    const operation = ctx.terminals.startSend(agent, id, { text: 'echo hi', submit: true })
    await expect(operation.done).resolves.toMatchObject({
      waitReason: 'session_exit',
      sessionStatus: { kind: 'exited', exitCode: 3, signal: null },
    })
    expect(pty.writes).toEqual([])
  })

  it('does not settle a send while the sandbox cannot be probed, and bounds it by the deadline', async () => {
    const { ctx, agent, id, pty } = await open({ ...FAST, timeoutMs: 120 })
    pty.foregroundFailure = new Error('sandbox unreachable')
    const operation = ctx.terminals.startSend(agent, id, { text: 'sleep 1', submit: true })
    await expect(operation.done).resolves.toMatchObject({ waitReason: 'timeout' })
  })

  it('delivers signals to the container foreground group', async () => {
    const { ctx, agent, id, pty } = await open()
    await expect(ctx.terminals.signal(agent, id, 'SIGINT')).resolves.toEqual({ delivered: true, targetPgid: 4242 })
    expect(pty.signals).toEqual(['SIGINT'])
  })

  it('cancels an active send through a real SIGINT', async () => {
    const { ctx, agent, id, pty } = await open({ ...FAST, timeoutMs: 60 })
    pty.foregroundFailure = new Error('sandbox unreachable')
    const operation: TerminalSendOperation = ctx.terminals.startSend(agent, id, { text: 'sleep 1', submit: true })
    expect(operation.cancel()).toBe(true)
    expect(pty.signals).toEqual(['SIGINT'])
    await expect(operation.done).resolves.toMatchObject({ waitReason: 'timeout' })
    expect(operation.cancel()).toBe(false)
  })

  it('pages retained scrollback newest-relative', async () => {
    const { ctx, agent, id, pty } = await open()
    pty.push('one\ntwo\nthree\n')
    // Observation is what moves sandbox output into the retained scrollback.
    await ctx.terminals.startSend(agent, id, { text: 'true', submit: true }).done

    expect(ctx.terminals.read(agent, id)).toEqual({
      text: 'one\ntwo\nthree\n',
      totalLines: 4,
      lineBegin: 0,
      lineEnd: 4,
      truncated: false,
    })
    expect(ctx.terminals.read(agent, id, { offset: 0, count: 2 })).toMatchObject({
      text: 'three\n',
      totalLines: 4,
      lineBegin: 0,
      lineEnd: 2,
    })
    expect(ctx.terminals.read(agent, id, { offset: 2, count: 1 })).toMatchObject({
      text: 'two',
      lineBegin: 2,
      lineEnd: 3,
    })
    expect(ctx.terminals.read(agent, id, { offset: 99 })).toEqual({
      text: '',
      totalLines: 4,
      lineBegin: 99,
      lineEnd: 99,
      truncated: false,
    })
  })

  it('rejects an impossible scrollback page request', async () => {
    const { ctx, agent, id } = await open()
    expect(() => ctx.terminals.read(agent, id, { offset: -1 })).toThrow('offset must be a non-negative safe integer')
    expect(() => ctx.terminals.read(agent, id, { count: 0 })).toThrow('count must be a positive safe integer')
  })

  it('bounds retained output and reports what it dropped', async () => {
    const { ctx, agent, id, pty } = await open({ ...FAST, scrollbackMaxBytes: 16, readMaxBytes: 16 })
    pty.push('x'.repeat(64))
    await ctx.terminals.startSend(agent, id, { text: 'true', submit: true }).done
    const page = ctx.terminals.read(agent, id)
    expect(page.text).toBe('x'.repeat(16))
    expect(page.truncated).toBe(true)
  })

  it('bounds one operation view and keeps the retained tail readable', async () => {
    const { ctx, agent, id, pty } = await open({ ...FAST, scrollbackMaxBytes: 8, readMaxBytes: 8 })
    const operation = ctx.terminals.startSend(agent, id, { text: 'true', submit: true })
    pty.push('0123456789')
    const result = await operation.done
    expect(result.truncated).toBe(true)
    expect(result.viewport).toBe('23456789')
    // The view is retained for a later readOutput, and consumed exactly once.
    expect(operation.readOutput()).toEqual({ delta: '23456789', truncated: true })
    expect(operation.readOutput()).toEqual({ delta: '', truncated: false })
  })

  it('settles a send as failed when the terminal can no longer be written to', async () => {
    const { ctx, agent, id, pty } = await open()
    pty.write = async () => { throw new Error('container CLI is gone') }
    const operation = ctx.terminals.startSend(agent, id, { text: 'echo hi', submit: true })
    await expect(operation.done).rejects.toThrow('container CLI is gone')
  })

  it('closes the container session through the registry', async () => {
    const { ctx, agent, id, pty } = await open()
    await expect(ctx.terminals.kill(agent, id, 'user request')).resolves.toBe(true)
    expect(pty.closeReasons).toEqual(['user request'])
    expect(ctx.terminals.list(agent)).toEqual([])
  })

  it('rejects a second send while one is in flight', async () => {
    const { ctx, agent, id, pty } = await open()
    pty.foregroundFailure = new Error('sandbox unreachable')
    ctx.terminals.startSend(agent, id, { text: 'sleep 1', submit: true })
    let thrown: unknown
    try {
      ctx.terminals.startSend(agent, id, { text: 'again', submit: true })
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'SEND_ACTIVE' })
  })

  it('reports a container runtime that cannot open a session, publishing nothing', async () => {
    const harness = await setup()
    harness.runtime.failWith = new Error('no sandbox for this tenant')
    await expect(harness.ctx.terminals.spawn(harness.agent, { type: 'shell' })).rejects.toThrow('no sandbox for this tenant')
    expect(harness.ctx.terminals.list(harness.agent)).toEqual([])
  })
})
