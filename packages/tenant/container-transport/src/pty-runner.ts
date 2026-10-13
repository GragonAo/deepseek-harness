/**
 * Terminal-launch seam for container-runtime providers: run one invocation of
 * the runtime's own binary with a terminal of its own.
 *
 * The binary needs one. `docker exec -i -t` refuses to start when its own stdin
 * is a pipe (`the input device is not a TTY`), and whether `kubectl exec -i -t`
 * still requests a remote TTY without one is not something a caller can rely
 * on. Giving the child a terminal makes both CLIs take the path they take in a
 * human's shell: they allocate a real PTY inside the container, put their own
 * stdin into raw mode, and forward window size and control bytes.
 *
 * @module @deepseek-ai/dsh-container-transport/pty-runner
 */

import { constants } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { ContainerPtyOutcome } from '@deepseek-ai/dsh-container'

/** One live runtime-CLI invocation that holds a terminal on the host. */
export interface ContainerPtyTransport {
  /** Host pid of the CLI process (not the terminal's in-container leader). */
  readonly pid: number
  /** Settles when the CLI process exits, whether by itself or by {@link terminate}. */
  readonly done: Promise<ContainerPtyOutcome>
  /**
   * Subscribe to terminal output.
   * @param listener - receives text decoded from the terminal as it arrives.
   * @returns a remover for exactly this listener.
   */
  onData(listener: (data: string) => void): () => void
  /**
   * Write text into the terminal's input.
   * @param data - text written verbatim.
   */
  write(data: string): void
  /**
   * Terminate the CLI process and await its exit: `SIGTERM`, then `SIGKILL`
   * once the grace period has passed. Idempotent, and an already-exited
   * process makes it a no-op.
   */
  terminate(): Promise<void>
}

/** Initial facts one interactive CLI invocation is started with. */
export interface ContainerPtyStart {
  /** Initial terminal height in rows. */
  rows: number
  /** Initial terminal width in columns. */
  cols: number
  /** How long a terminated CLI may take to exit before it is killed outright. */
  graceMs: number
}

/**
 * One runnable interactive container-runtime CLI surface (production: the
 * `docker`, `podman`, or `kubectl` binary).
 */
export interface ContainerPtyRunner {
  /**
   * Start one CLI invocation under a terminal.
   * @param args - subcommand and arguments for that binary.
   * @param spec - initial terminal size and termination grace.
   * @returns the live invocation.
   */
  start(args: readonly string[], spec: ContainerPtyStart): Promise<ContainerPtyTransport>
}

/**
 * Attach a terminal-launching runner to one container-runtime binary.
 * @param binary - the executable to spawn, e.g. `docker` or `kubectl`.
 * @returns the runner that invokes that binary.
 */
export function ptyRunner(binary: string): ContainerPtyRunner {
  return { start: (args, spec) => startInvocation(binary, args, spec) }
}

/**
 * Name of a POSIX signal number, as the operating system reports it.
 * @param signal - signal number from a child's exit status.
 * @returns the signal's name, or `null` when this host cannot name it.
 */
export function signalName(signal: number): NodeJS.Signals | null {
  for (const [name, number] of Object.entries(constants.signals)) {
    if (number === signal) return name as NodeJS.Signals
  }
  return null
}

async function startInvocation(
  binary: string,
  args: readonly string[],
  spec: ContainerPtyStart,
): Promise<ContainerPtyTransport> {
  const nodePty = await loadNodePty(binary)
  // The CLI keeps the host's environment on purpose: `kubectl` resolves its
  // kubeconfig through it and `docker` finds its context, exactly as the
  // one-shot runner's inherited environment does.
  const child = nodePty.spawn(binary, [...args], { rows: spec.rows, cols: spec.cols })
  const listeners = new Set<(data: string) => void>()
  let exited = false
  const done = new Promise<ContainerPtyOutcome>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      exited = true
      // A signalled child reports its signal, and its "code" is then this
      // host's rendering of it rather than an in-container process's code.
      resolve(signal === undefined || signal === 0
        ? { exitCode, signal: null }
        : { exitCode: null, signal: signalName(signal) })
    })
  })
  child.onData((data: string) => {
    for (const listener of [...listeners]) listener(data)
  })
  return {
    pid: child.pid,
    done,
    onData(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    write(data) {
      child.write(data)
    },
    async terminate() {
      if (exited) {
        await done
        return
      }
      try {
        child.kill('SIGTERM')
      } catch (_processAlreadyExited) {
        // The exit event is the authority on whether the CLI is gone; asking a
        // dead pid to die again is not a failure.
      }
      if (await settlesWithin(done, spec.graceMs)) return
      child.kill('SIGKILL')
      await done
    },
  }
}

/**
 * Resolve node-pty late, so a host that cannot load the native addon still
 * serves every one-shot operation: the addon is needed by interactive
 * sessions alone, and failing an entire container runtime at plugin load
 * would take down filesystem, exec, and code execution with it.
 */
async function loadNodePty(binary: string): Promise<typeof import('node-pty')> {
  try {
    return await import('node-pty')
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `container-transport: an interactive container session needs a local terminal for '${binary}', ` +
        `and the 'node-pty' module did not load in this host: ${reason}`,
    )
  }
}

/**
 * Whether `settled` reaches a value before `ms` elapses.
 * @param settled - the promise to watch.
 * @param ms - how long to wait for it.
 * @returns `true` when it settled first, `false` when the wait expired.
 */
export async function settlesWithin(settled: Promise<unknown>, ms: number): Promise<boolean> {
  const elapsed = new AbortController()
  try {
    return await Promise.race([settled.then(() => true), delay(ms, false, { signal: elapsed.signal })])
  } finally {
    // The race settles on the first arrival; the loser's timer must not outlive it.
    elapsed.abort()
  }
}
