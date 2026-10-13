import { describe, expect, it, vi } from 'vitest'
import type { ContainerCommandResult, ContainerPtyOptions, ContainerPtyOutcome } from '@deepseek-ai/dsh-container'
import { openContainerPty } from '../src/pty-session.ts'
import type { ContainerSessionExec } from '../src/pty-session.ts'
import type { ContainerPtyRunner, ContainerPtyTransport } from '../src/pty-runner.ts'
import { SESSION_HANDSHAKE, handshakeLine } from '../src/session-probe.ts'

const LIVE_LEADER = 'DSH_PTY_MEMBER 42 42\nDSH_PTY_LEADER 42 42\n'
const LEADER_AT_PROMPT = 'DSH_PTY_MEMBER 4242 4242\nDSH_PTY_LEADER 4242 4242\n'

/**
 * The program `signalArgv` hands its interpreter. The session signals a group by
 * running a shell, so this text is what tells a signal apart from a probe.
 */
const SIGNAL_PROGRAM = 'kill -s "${1#SIG}" -- "-$2"'

/** The one-shot exec a signal delivery makes, as the session's argv gives it. */
function signalCall(pgid: number, signal: string): { command: string; args: readonly string[] } {
  return { command: '/bin/sh', args: ['-c', SIGNAL_PROGRAM, 'sh', signal, String(pgid)] }
}

const BASE_OPTIONS: ContainerPtyOptions = {
  command: 'bash',
  rows: 40,
  cols: 160,
  maxOutputBytes: 4_096,
  disposeGraceMs: 10,
}

/** The terminal the host allocated: the test plays both its output and its end. */
class FakeTransport implements ContainerPtyTransport {
  readonly writes: string[] = []
  readonly done: Promise<ContainerPtyOutcome>
  terminations = 0
  /** Output produced when the handshake line reaches the terminal. */
  handshakeOutput: string | undefined
  /** Exit reported right after that output, for a command that ended before the handshake. */
  exitAfterHandshake: number | null | undefined

  private settleDone!: (outcome: ContainerPtyOutcome) => void
  private readonly listeners = new Set<(data: string) => void>()

  constructor(readonly pid = 4242) {
    this.done = new Promise((resolve) => { this.settleDone = resolve })
  }

  onData(listener: (data: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async write(data: string): Promise<void> {
    this.writes.push(data)
    if (!data.includes(SESSION_HANDSHAKE)) return
    if (this.handshakeOutput !== undefined) this.emit(this.handshakeOutput)
    if (this.exitAfterHandshake !== undefined) this.exit(this.exitAfterHandshake)
  }

  async terminate(): Promise<void> {
    this.terminations += 1
    this.exit(null)
  }

  /** Produce terminal output, as the shell inside the sandbox would. */
  emit(data: string): void {
    for (const listener of this.listeners) listener(data)
  }

  /** End the in-container command. */
  exit(exitCode: number | null): void {
    this.settleDone({ exitCode, signal: null })
  }
}

/** The signal that reaches the fake transport when the handshake is answered. */
function answering(output: string): FakeTransport {
  const transport = new FakeTransport()
  transport.handshakeOutput = output
  return transport
}

interface SandboxScript {
  /** State probe answers, consumed in order; the last one repeats. */
  readonly states: readonly string[]
  /** Whether a delivered signal ends the session's processes. */
  readonly killEnds?: boolean
  /** Probe stderr when the sandbox refuses to be read. */
  readonly probeFails?: string
}

/** One-shot exec over the sandbox, scripted per test. */
function sandbox(transport: FakeTransport, script: SandboxScript) {
  const calls: { command: string; args: readonly string[] }[] = []
  let probeIndex = 0
  const exec: ContainerSessionExec = async (command, args): Promise<ContainerCommandResult> => {
    calls.push({ command, args })
    if (command === '/bin/sh' && args[1] === SIGNAL_PROGRAM) {
      if (script.killEnds === true) transport.exit(null)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (script.probeFails !== undefined) return { exitCode: 1, stdout: '', stderr: script.probeFails }
    const state = script.states[Math.min(probeIndex, script.states.length - 1)] ?? ''
    probeIndex += 1
    return { exitCode: 0, stdout: state, stderr: '' }
  }
  return {
    exec,
    calls,
    kills: (): { command: string; args: readonly string[] }[] =>
      calls.filter(call => call.command === '/bin/sh' && call.args[1] === SIGNAL_PROGRAM),
  }
}

function runnerFor(transport: FakeTransport) {
  const starts: { args: readonly string[]; rows: number; cols: number; graceMs: number }[] = []
  const runner: ContainerPtyRunner = {
    async start(args, spec) {
      starts.push({ args, rows: spec.rows, cols: spec.cols, graceMs: spec.graceMs })
      return transport
    },
  }
  return { runner, starts }
}

async function open(
  transport: FakeTransport,
  exec: ContainerSessionExec,
  options: Partial<ContainerPtyOptions> = {},
  roundTripTimeoutMs = 1_000,
) {
  const { runner, starts } = runnerFor(transport)
  const session = await openContainerPty({
    argv: ['exec', '-i', '-t', 'sandbox', 'sh', '-c', 'bash'],
    options: { ...BASE_OPTIONS, ...options },
    runner,
    exec,
    roundTripTimeoutMs,
  })
  return { session, starts }
}

describe('openContainerPty', () => {
  it('starts the runtime CLI on a terminal of the requested size', async () => {
    const transport = answering(`${handshakeLine()}\r\nDSH_PTY_SESSION 42\r\nbash-5.2# `)
    const { starts } = await open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec)
    expect(starts).toEqual([{
      args: ['exec', '-i', '-t', 'sandbox', 'sh', '-c', 'bash'],
      rows: 40,
      cols: 160,
      graceMs: 10,
    }])
  })

  it('identifies the session, drops boot noise, and serves later output', async () => {
    const transport = answering(`${handshakeLine()}\r\nbash-5.2# DSH_PTY_SESSION 42\r\nD-SH-READY `)
    const { session } = await open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec)
    expect(session.pid).toBe(42)
    expect(session.read()).toEqual({ data: 'D-SH-READY ', truncated: false })
    expect(session.read()).toEqual({ data: '', truncated: false })

    transport.emit('ls output\n')
    expect(session.read()).toEqual({ data: 'ls output\n', truncated: false })
  })

  it('bounds retained output and reports what it dropped', async () => {
    const transport = answering('DSH_PTY_SESSION 42\r\n')
    const { session } = await open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec, { maxOutputBytes: 8 })
    transport.emit('0123456789012')
    expect(session.read()).toEqual({ data: '56789012', truncated: true })
  })

  it('feeds terminal input verbatim', async () => {
    const transport = answering('DSH_PTY_SESSION 42\r\n')
    const { session } = await open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec)
    await session.write('echo hi\n')
    expect(transport.writes.at(-1)).toBe('echo hi\n')
  })

  it('refuses a command that never reported a session, naming what it printed', async () => {
    const transport = new FakeTransport()
    transport.handshakeOutput = 'dsh: cannot enter /nope\n'
    transport.exitAfterHandshake = 126
    await expect(open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec))
      .rejects.toThrow(/ended before it reported a terminal session.*cannot enter \/nope/s)
    expect(transport.terminations).toBe(1)
  })

  it('refuses a command that produced output without ever answering', async () => {
    const transport = new FakeTransport()
    transport.handshakeOutput = 'x'.repeat(64)
    await expect(open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec, { maxOutputBytes: 16 }))
      .rejects.toThrow('produced more than 16 bytes without reporting a terminal session')
    expect(transport.terminations).toBe(1)
  })

  it('bounds the wait for the answer and closes the CLI when it never comes', async () => {
    const transport = new FakeTransport()
    await expect(open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec, {}, 20))
      .rejects.toThrow('did not report a terminal session within 20ms')
    expect(transport.terminations).toBe(1)
  })

  it('disarms the handshake deadline once the session answered', async () => {
    vi.useFakeTimers()
    try {
      const transport = answering('DSH_PTY_SESSION 42\r\n')
      const { session } = await open(transport, sandbox(transport, { states: [LIVE_LEADER] }).exec, {}, 60_000)
      // 认出会话之后这个期限再无用处：留在宿主进程里就是每个活着的会话各留一个计时器。
      expect(vi.getTimerCount()).toBe(0)
      await expect(session.write('echo hi\n')).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a session whose processes are already gone', async () => {
    const transport = answering('DSH_PTY_SESSION 42\r\n')
    await expect(open(transport, sandbox(transport, { states: [''] }).exec))
      .rejects.toThrow('no process of that session is alive to be signalled')
    expect(transport.terminations).toBe(1)
  })

  it('reports a sandbox that refuses the process probe', async () => {
    const transport = answering('DSH_PTY_SESSION 42\r\n')
    await expect(open(transport, sandbox(transport, { states: [LIVE_LEADER], probeFails: 'sh: not found' }).exec))
      .rejects.toThrow('reading the sandbox process table failed (exit 1): sh: not found')
  })

  it('cancels unpublished setup before any CLI is launched', async () => {
    const transport = new FakeTransport()
    const controller = new AbortController()
    controller.abort(new Error('caller gave up'))
    await expect(openContainerPty({
      argv: ['exec'],
      options: { ...BASE_OPTIONS, signal: controller.signal },
      runner: runnerFor(transport).runner,
      exec: sandbox(transport, { states: [LIVE_LEADER] }).exec,
      roundTripTimeoutMs: 1_000,
    })).rejects.toThrow('caller gave up')
    expect(transport.terminations).toBe(0)
  })

  it('ends the CLI when the caller cancels while the terminal is being attached', async () => {
    const transport = new FakeTransport()
    const controller = new AbortController()
    const runner: ContainerPtyRunner = {
      async start() {
        controller.abort(new Error('caller gave up'))
        return transport
      },
    }
    await expect(openContainerPty({
      argv: ['exec'],
      options: { ...BASE_OPTIONS, signal: controller.signal },
      runner,
      exec: sandbox(transport, { states: [LIVE_LEADER] }).exec,
      roundTripTimeoutMs: 1_000,
    })).rejects.toThrow('caller gave up')
    expect(transport.terminations).toBe(1)
  })
})

describe('container terminal session lifecycle', () => {
  it('reports the terminal\'s foreground group and signals it by group', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT, 'DSH_PTY_MEMBER 4242 77\nDSH_PTY_LEADER 4242 77\n'] })
    const { session } = await open(transport, fake.exec)
    await expect(session.foreground()).resolves.toEqual({ pgid: 77 })
    await expect(session.signal('SIGINT')).resolves.toBe(77)
    expect(fake.kills().at(-1)).toEqual(signalCall(77, 'SIGINT'))
  })

  it('falls back to the session\'s own group when the terminal reports none', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT, 'DSH_PTY_MEMBER 4242 -1\nDSH_PTY_LEADER 4242 -1\n'] })
    const { session } = await open(transport, fake.exec)
    await expect(session.foreground()).resolves.toEqual({ pgid: 4242 })
    await expect(session.signal('SIGINT')).resolves.toBe(4242)
  })

  it('refuses SIGKILL while the session leader holds the terminal', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT] })
    const { session } = await open(transport, fake.exec)
    await expect(session.signal('SIGKILL')).rejects.toThrow('SIGKILL was refused')
    expect(fake.kills()).toEqual([])
  })

  it('refuses to signal a session that has no live process group', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT, ''] })
    const { session } = await open(transport, fake.exec)
    await expect(session.signal('SIGTERM')).rejects.toThrow('has no live process group to signal')
    await expect(session.foreground()).resolves.toBeUndefined()
  })

  it('ends the session with TERM and verifies its processes are gone', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT, LEADER_AT_PROMPT, ''], killEnds: true })
    const { session } = await open(transport, fake.exec)
    await expect(session.close('terminal_close')).resolves.toBeUndefined()
    expect(fake.kills()).toEqual([signalCall(4242, 'SIGTERM')])
    expect(transport.terminations).toBe(1)
    await expect(session.write('echo hi\n')).rejects.toThrow('the session is closing')
    await expect(session.signal('SIGINT')).rejects.toThrow('the session is closing')
  })

  it('escalates to SIGKILL and refuses to claim success while a group survives', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT] })
    const { session } = await open(transport, fake.exec)
    await expect(session.close('terminal_close')).rejects.toThrow('survived SIGKILL (close reason: terminal_close)')
    expect(fake.kills()).toEqual([signalCall(4242, 'SIGTERM'), signalCall(4242, 'SIGKILL')])
    expect(transport.terminations).toBe(1)
  })

  it('retries a close that failed once the sandbox answers again', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT, LEADER_AT_PROMPT, ''], killEnds: true })
    const { session } = await open(transport, fake.exec)
    const failure = session.close('first attempt')
    await expect(failure).resolves.toBeUndefined()
    await expect(session.close('second attempt')).resolves.toBeUndefined()
    expect(transport.terminations).toBe(1)
    expect(fake.kills()).toEqual([signalCall(4242, 'SIGTERM')])
  })

  it('closes a session whose processes are already gone without signalling', async () => {
    const transport = answering('DSH_PTY_SESSION 4242\r\n')
    const fake = sandbox(transport, { states: [LEADER_AT_PROMPT, ''] })
    const { session } = await open(transport, fake.exec)
    await expect(session.close('terminal_close')).resolves.toBeUndefined()
    expect(fake.kills()).toEqual([])
    expect(transport.terminations).toBe(1)
  })
})
