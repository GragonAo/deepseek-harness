/**
 * The container-runtime interactive session, implemented once for every
 * provider: it starts the runtime CLI under a local terminal, learns from
 * inside the sandbox which session that terminal runs, retains a bounded
 * output tail, and ends the session with verification.
 *
 * A provider contributes its own argv and a one-shot exec bound to the sandbox
 * it already resolved, so `docker`, `podman`, and `kubectl` differ in one
 * string each instead of in the session's semantics.
 *
 * @module @deepseek-ai/dsh-container-transport/pty-session
 */

import type {
  ContainerCommandResult,
  ContainerPtyForeground,
  ContainerPtyOptions,
  ContainerPtyOutcome,
  ContainerPtyRead,
  ContainerPtySession,
  ContainerPtySignal,
} from '@deepseek-ai/dsh-container'
import type { ContainerPtyRunner, ContainerPtyTransport } from './pty-runner.ts'
import { settlesWithin } from './pty-runner.ts'
import { handshakeLine, parseHandshake, parseState, signalArgv, stateScript } from './session-probe.ts'
import type { ContainerPtyHandshake, ContainerPtyState } from './session-probe.ts'

/** One one-shot command inside the sandbox a session was opened in. */
export type ContainerSessionExec = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<ContainerCommandResult>

/** What a session learned about itself by looking inside the container. */
interface ContainerPtyIdentity {
  /** Session id of the process the terminal runs. */
  sessionId: number
  /** Process group led by that process. */
  leaderPgid: number
}

/** How much of a command's own output one startup failure reports back. */
const STARTUP_DIAGNOSTIC_BYTES = 512

/** What a provider supplies to open one interactive session. */
export interface ContainerPtyOpen {
  /** Arguments for the runtime binary, i.e. the `exec -i -t` invocation. */
  argv: readonly string[]
  /** The caller's request. */
  options: ContainerPtyOptions
  /** Terminal-launching seam. */
  runner: ContainerPtyRunner
  /** One-shot exec bound to the sandbox, for the session's own probes. */
  exec: ContainerSessionExec
  /**
   * Deadline for one round trip to the sandbox: attaching the terminal, and
   * each later probe. Attaching is a round trip like any other, and a caller
   * that never bounded it would wait forever on a wedged runtime.
   */
  roundTripTimeoutMs: number
}

/**
 * Open one interactive session, published once its terminal is identified.
 * @param open - provider argv, the caller's request, and both transport seams.
 * @returns the live session.
 * @throws when the CLI cannot start, when the command never took over its
 * terminal, or when the sandbox cannot be probed; the CLI is terminated before
 * throwing, and a cleanup failure is reported together with the original one.
 */
export async function openContainerPty(open: ContainerPtyOpen): Promise<ContainerPtySession> {
  open.options.signal?.throwIfAborted()
  const transport = await open.runner.start(open.argv, {
    rows: open.options.rows,
    cols: open.options.cols,
    graceMs: open.options.disposeGraceMs,
  })
  const session = new ContainerPtySessionImpl(open, transport)
  try {
    await session.identify()
    return session
  } catch (error: unknown) {
    try {
      await transport.terminate()
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'a container terminal failed to start, and its container CLI could not be terminated',
      )
    }
    throw error
  }
}

/**
 * The bound on one startup's handshake, fused with the caller's own
 * cancellation: whichever arrives first refuses the wait, and the caller's
 * reason is the one reported when the caller is the one that gave up.
 * @param caller - the caller's cancellation, when it asked for one.
 * @param ms - how long the command may take to report its terminal session.
 * @returns the refusal to race the handshake against, and the disarm that takes
 * the timer and its abort listeners back once the handshake arrived.
 */
function startupDeadline(caller: AbortSignal | undefined, ms: number): {
  refusal: Promise<never>
  disarm: () => void
} {
  const elapsed = new AbortController()
  const timer = setTimeout(() => {
    elapsed.abort(new Error(
      `container-transport: the container command did not report a terminal session within ${String(ms)}ms`,
    ))
  }, ms)
  // A session waiting for its shell is not work the host must stay awake for.
  timer.unref()
  let refuse!: (error: unknown) => void
  const refusal = new Promise<never>((_resolve, reject) => {
    refuse = reject
  })
  const signals = caller === undefined ? [elapsed.signal] : [elapsed.signal, caller]
  const listeners = signals.map((signal) => {
    const onAbort = (): void => {
      refuse(signal.reason instanceof Error
        ? signal.reason
        : new Error(`container-transport: opening a container terminal was aborted: ${String(signal.reason)}`))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return { signal, onAbort }
  })
  return {
    refusal,
    disarm: () => {
      clearTimeout(timer)
      for (const { signal, onAbort } of listeners) signal.removeEventListener('abort', onAbort)
    },
  }
}

class ContainerPtySessionImpl implements ContainerPtySession {
  /** Session id inside the container and its leader, learned from the sandbox. */
  private identity: ContainerPtyIdentity | undefined
  /** Output of the terminal, until the handshake identifies the session. */
  private startup = ''
  /** Output not yet consumed by {@link read}. */
  private pending = ''
  /** Whether output was dropped from {@link pending} by the retained-byte bound. */
  private dropped = false
  private identified = false
  /**
   * Whether a startup failure still has an observer. Once `identify` stops
   * waiting — it answered, it timed out, the caller cancelled — the handshake
   * promise has no reader, and rejecting it would surface as an unhandled
   * rejection; an ended command is then the outcome `done` already reports.
   */
  private awaitingStartup = true
  private closing = false
  private closePromise: Promise<void> | undefined

  private readonly handshaken: Promise<ContainerPtyHandshake>
  private readonly report: (handshake: ContainerPtyHandshake) => void
  private readonly reportFailure: (error: unknown) => void

  constructor(
    private readonly open: ContainerPtyOpen,
    private readonly transport: ContainerPtyTransport,
  ) {
    let report!: (handshake: ContainerPtyHandshake) => void
    let reportFailure!: (error: unknown) => void
    this.handshaken = new Promise<ContainerPtyHandshake>((resolve, reject) => {
      report = resolve
      reportFailure = reject
    })
    this.report = report
    this.reportFailure = reportFailure
    transport.onData((data: string) => {
      if (this.identified) {
        this.receive(data)
        return
      }
      this.startup += data
      const handshake = parseHandshake(this.startup)
      if (handshake !== undefined) this.report(handshake)
      else if (Buffer.byteLength(this.startup, 'utf8') > open.options.maxOutputBytes) {
        this.failStartup(new Error(
          `container-transport: the container command produced more than ${String(open.options.maxOutputBytes)} bytes ` +
            'without reporting a terminal session; it is not an interactive session',
        ))
      }
    })
    void transport.done.then(() => {
      // The tail of what the command printed is the only diagnostic this path
      // has — a sandbox that refused the command, a working directory the image
      // does not have — and it is bounded like every other retained output.
      const tail = byteTail(this.startup, STARTUP_DIAGNOSTIC_BYTES).trim()
      this.failStartup(new Error(
        'container-transport: the container command ended before it reported a terminal session' +
          (tail.length > 0 ? `; its output was: ${tail}` : ''),
      ))
    })
  }

  get pid(): number {
    return this.requireIdentity().leaderPgid
  }

  get done(): Promise<ContainerPtyOutcome> {
    return this.transport.done
  }

  /**
   * Learn which session this terminal runs and which process group leads it.
   * A session without a live leader is refused here: it could never be
   * signalled, and its terminal would keep a process the caller cannot reach.
   * @throws when the shell never answers, when the caller cancels, when the
   * terminal ended first, when the sandbox refuses the probe, or when nothing
   * is left alive in the terminal's session.
   */
  async identify(): Promise<void> {
    try {
      const caller = this.open.options.signal
      // The caller may have cancelled while the runtime CLI was starting, which
      // is the widest window this setup has; an already-aborted signal never
      // fires its abort event, so the check cannot be left to the race below.
      caller?.throwIfAborted()
      this.transport.write(handshakeLine())
      const deadline = startupDeadline(caller, this.open.roundTripTimeoutMs)
      let handshake: ContainerPtyHandshake
      try {
        handshake = await Promise.race([this.handshaken, deadline.refusal])
      } finally {
        // The bound exists for this handshake alone: an identified session that
        // left it armed would hold one timer per live session in the host.
        deadline.disarm()
      }
      const state = await this.probeSession(handshake.sessionId)
      if (state.leaderPgid === undefined) {
        throw new Error(
          `container-transport: the container command holds terminal session ${String(handshake.sessionId)}, ` +
            'but no process of that session is alive to be signalled',
        )
      }
      this.identity = { sessionId: handshake.sessionId, leaderPgid: state.leaderPgid }
      // Everything up to the end of the handshake's own line is boot noise —
      // the terminal's echo of the line, the shell's first prompt, any banner —
      // and none of it is output the caller asked for.
      const rest = this.startup.slice(handshake.end)
      this.startup = ''
      this.identified = true
      this.receive(rest)
    } finally {
      this.awaitingStartup = false
    }
  }

  /** Report a startup failure, while {@link identify} is still the one waiting. */
  private failStartup(error: unknown): void {
    if (!this.awaitingStartup) return
    this.reportFailure(error)
  }

  read(): ContainerPtyRead {
    const data = this.pending
    const truncated = this.dropped
    this.pending = ''
    this.dropped = false
    return { data, truncated }
  }

  async write(data: string): Promise<void> {
    if (this.closing) throw new Error('container-transport: the session is closing')
    this.transport.write(data)
  }

  async foreground(): Promise<ContainerPtyForeground | undefined> {
    const state = await this.probe()
    // A session leader that already ended leaves `tpgid`/leader unreadable while
    // its group's members still run; one remaining group is then the only
    // candidate there is, and naming it keeps the terminal reachable.
    const only = state.groups.length === 1 ? state.groups[0] : undefined
    const pgid = state.foregroundPgid ?? state.leaderPgid ?? only
    if (pgid === undefined) return undefined
    return { pgid }
  }

  async signal(signal: ContainerPtySignal): Promise<number> {
    if (this.closing) throw new Error('container-transport: the session is closing')
    const identity = this.requireIdentity()
    const foreground = await this.foreground()
    if (foreground === undefined) {
      throw new Error(
        `container-transport: session ${String(identity.sessionId)} has no live process group to signal; ` +
          'its processes have ended',
      )
    }
    // The terminal's foreground group is the session leader's own group only
    // while the shell holds the terminal, so `SIGKILL` would end the session
    // instead of interrupting a command. Refusing keeps the terminal usable;
    // `close` is the operation that ends sessions.
    if (signal === 'SIGKILL' && foreground.pgid === identity.leaderPgid) {
      throw new Error(
        'container-transport: SIGKILL was refused because the session leader holds the terminal; ' +
          'signal a running command while it holds the terminal, or close the session',
      )
    }
    await this.signalGroup(foreground.pgid, signal)
    return foreground.pgid
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      // A failed close is retryable — the caller may retry once the sandbox
      // answers again — so the rejection must not be memoized.
      this.closePromise = undefined
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private async closeOnce(reason: string): Promise<void> {
    let failure: unknown
    try {
      const groups = (await this.probe()).groups
      if (groups.length > 0) {
        await this.signalGroups(groups, 'SIGTERM')
        // The CLI exits as soon as the session's leader does, which is the
        // common case; the grace is only spent when something outlives it.
        await settlesWithin(this.transport.done, this.open.options.disposeGraceMs)
        const survivors = (await this.probe()).groups
        if (survivors.length > 0) {
          await this.signalGroups(survivors, 'SIGKILL')
          const remaining = (await this.probe()).groups
          if (remaining.length > 0) {
            throw new Error(
              `container-transport: process groups ${remaining.join(', ')} of session ` +
                `${String(this.requireIdentity().sessionId)} survived SIGKILL (close reason: ${reason})`,
            )
          }
        }
      }
    } catch (error: unknown) {
      failure = error
    }
    try {
      await this.transport.terminate()
    } catch (error: unknown) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }

  private receive(data: string): void {
    this.pending += data
    const max = this.open.options.maxOutputBytes
    if (Buffer.byteLength(this.pending, 'utf8') <= max) return
    this.pending = byteTail(this.pending, max)
    this.dropped = true
  }

  private async probe(): Promise<ContainerPtyState> {
    return await this.probeSession(this.requireIdentity().sessionId)
  }

  private async probeSession(sessionId: number): Promise<ContainerPtyState> {
    // Any POSIX shell reads `/proc` and prints, so the probe takes whichever `sh`
    // the image resolves. A signal delivery cannot: there the shell's own builtin
    // is what addresses the group, which is why `signalArgv` names its interpreter.
    const result = await this.open.exec('sh', ['-c', stateScript(sessionId)], AbortSignal.timeout(this.open.roundTripTimeoutMs))
    if (result.exitCode !== 0) {
      throw new Error(
        `container-transport: reading the sandbox process table failed (exit ${String(result.exitCode)}): ` +
          `${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    return parseState(result.stdout)
  }

  private requireIdentity(): ContainerPtyIdentity {
    const identity = this.identity
    if (identity === undefined) throw new Error('container-transport: the terminal session is not identified yet')
    return identity
  }

  /** Signal every listed group, letting an already-ended group be the outcome. */
  private async signalGroups(groups: readonly number[], signal: ContainerPtySignal): Promise<void> {
    for (const group of groups) {
      await this.signalGroup(group, signal).catch(() => undefined)
    }
  }

  private async signalGroup(pgid: number, signal: ContainerPtySignal): Promise<void> {
    const [command, args] = signalArgv(pgid, signal)
    const result = await this.open.exec(command, args, AbortSignal.timeout(this.open.roundTripTimeoutMs))
    if (result.exitCode !== 0) {
      throw new Error(
        `container-transport: delivering ${signal} to process group ${String(pgid)} failed (exit ` +
          `${String(result.exitCode)}): ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
  }
}

/**
 * The last `maxBytes` bytes of `text`, starting at a character boundary.
 * @param text - the text to bound.
 * @param maxBytes - how many trailing bytes to keep.
 * @returns the bounded tail.
 */
function byteTail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  let start = Math.max(0, bytes.length - maxBytes)
  // A cut inside a multibyte sequence would decode to a replacement character;
  // skipping continuation bytes starts the tail at the next character.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}
