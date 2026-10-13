/**
 * Container-runtime Service Definition (`ctx.containerRuntime`): shared
 * ownership of one tenant-scoped container execution world. Filesystem and
 * subprocess adapters await the same runtime, so file and process operations
 * inhabit one isolated Linux world per tenant.
 * @module @deepseek-ai/dsh-container
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** Exit facts and captured streams of one completed container command. */
export interface ContainerCommandResult {
  /** Exit code of the command (docker/podman exec propagates the process code). */
  exitCode: number
  /** Captured stdout, decoded as UTF-8（被沙箱内上界截断时只保留末尾一段）。 */
  stdout: string
  /** Captured stderr, decoded as UTF-8（被沙箱内上界截断时只保留末尾一段）。 */
  stderr: string
  /**
   * stdout 被沙箱内的上界截断时为 true：这段文本是末尾一段，前面还有已经丢弃的字节。
   * 没有截断时这个字段不出现，调用方据此区分「这就是全部输出」。
   */
  stdoutTruncated?: boolean
  /** stderr 的同一件事，语义与 {@link ContainerCommandResult.stdoutTruncated} 相同。 */
  stderrTruncated?: boolean
}

/** Optional per-execution controls. */
export interface ContainerExecOptions {
  /** Bytes written to the command's stdin, then closed. */
  stdin?: string
  /** Working directory inside the container (the host maps `-w`). */
  cwd?: string
  /** Explicit environment entries layered onto the container process. */
  env?: Readonly<Record<string, string>>
  /** Aborts the exec (the runner kills the spawned CLI process). */
  signal?: AbortSignal
}

/** Signals an interactive container session may deliver to its foreground process group. */
export type ContainerPtySignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/**
 * One request for an interactive session inside the ambient tenant's container.
 *
 * There is no `cwd` and no `env`: the command line owns its own setup. Only
 * `docker exec` offers `-w`/`-e` to set them, while `kubectl exec` has no such
 * flags, and a definition that cannot be honored by every provider would give
 * its callers a working directory on one deployment and the image's own default
 * on another. A caller therefore brackets its command with `sh -c`, which both
 * CLIs pass through verbatim.
 */
export interface ContainerPtyOptions {
  /** Executable inside the container that holds the session's terminal. */
  command: string
  /** Positional arguments (never shell-interpreted here). */
  args?: readonly string[]
  /** Initial terminal height in rows, as reported to the container's terminal. */
  rows: number
  /** Initial terminal width in columns. */
  cols: number
  /**
   * Bytes of output retained for the caller before the oldest are dropped.
   * An interactive session has no end to buffer for, and a provider that
   * accumulated without a bound would hold a chatty session's whole output in
   * the host process.
   */
  maxOutputBytes: number
  /**
   * How long `close` waits after `SIGTERM` before escalating to `SIGKILL`.
   * Interactive processes ignore `SIGTERM` often enough — a shell at a prompt
   * among them — that teardown needs a bound of its own, and the deployment
   * decides how long a session may take to die.
   */
  disposeGraceMs: number
  /** Aborts an allocation that has not been published yet. */
  signal?: AbortSignal
}

/** Output consumed from one interactive session. */
export interface ContainerPtyRead {
  /** Output produced since the previous read, decoded as UTF-8. */
  data: string
  /** Whether earlier output was dropped by {@link ContainerPtyOptions.maxOutputBytes}. */
  truncated: boolean
}

/** How an interactive session's process ended. */
export interface ContainerPtyOutcome {
  /** Exit code of the in-container process; `null` when a signal ended it. */
  exitCode: number | null
  /** Signal that ended it, when the transport could name one. */
  signal: NodeJS.Signals | null
}

/** Which process group currently holds an interactive session's terminal. */
export interface ContainerPtyForeground {
  /** Process group the terminal delivers input to. */
  pgid: number
}

/**
 * One live interactive session inside a container, owned by the caller that
 * opened it. Output is pulled, not pushed, so a slow consumer never has a
 * callback re-entering its own state; a bounded retained tail is what `read`
 * serves, and dropping older output is reported rather than silent.
 */
export interface ContainerPtySession {
  /**
   * Process id of the terminal's session leader, observed while the session
   * was being established. It is a container-namespace pid and means nothing
   * outside this session.
   */
  readonly pid: number
  /** Settles when the in-container process ends. */
  readonly done: Promise<ContainerPtyOutcome>
  /** @returns output produced since the previous read. */
  read(): ContainerPtyRead
  /**
   * Feed the session's terminal input.
   * @param data - text written verbatim, exactly as a terminal would receive it.
   */
  write(data: string): Promise<void>
  /**
   * Observe which process group holds the session's terminal, by reading the
   * container's own process table.
   * @returns the foreground group, or `undefined` when the session has no live
   * process group left.
   * @throws when the container cannot be reached for the observation.
   */
  foreground(): Promise<ContainerPtyForeground | undefined>
  /**
   * Deliver one signal to the terminal's foreground process group.
   * @param signal - signal to deliver.
   * @returns the process group id that received it.
   * @throws when the session is closing, when its terminal has no foreground
   * group, when the container no longer answers, or for `SIGKILL` while the
   * foreground group is the session leader's own group — see the package README.
   */
  signal(signal: ContainerPtySignal): Promise<number>
  /**
   * End the session and await quiescence.
   * @param reason - human-readable reason retained for diagnostics.
   * @throws when the provider cannot reach the container to confirm the
   * session's processes are gone; the local transport is closed regardless.
   */
  close(reason: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    containerRuntime: ContainerRuntime
  }
}

/**
 * Abstract container runtime (`ctx.containerRuntime`). A provider runs
 * commands inside the ambient tenant's container — the container whose
 * `/workspace` binds that tenant's workspace root and `/tools` binds its
 * tooling — resolved per call from `requireTenant()`.
 */
export abstract class ContainerRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'containerRuntime')
  }

  /**
   * Run one command in the ambient tenant's container and capture its streams.
   * @param command - the executable inside the container.
   * @param args - positional arguments (never shell-interpreted here).
   * @param opts - optional stdin feed and cancellation.
   * @returns the command's exit code and captured stdout/stderr.
   * @throws `TenantError` code `NO_TENANT_IN_SCOPE` outside an authenticated request.
   */
  abstract exec(
    command: string,
    args: readonly string[],
    opts?: ContainerExecOptions,
  ): Promise<ContainerCommandResult>

  /**
   * Open one interactive session in the ambient tenant's container, over a
   * terminal allocated by the container runtime itself.
   *
   * `exec` cannot serve this: it captures a completed command's streams and has
   * no way to keep stdin open, to size a terminal, or to signal a process that
   * is still running. A session opened here is live until it is closed or its
   * process ends, and it outlives the call that opened it.
   *
   * @param options - command line, terminal size, retained-output bound, cancellation.
   * @returns a live session holding the returned terminal.
   * @throws `TenantError` code `NO_TENANT_IN_SCOPE` outside an authenticated
   * request, and the provider's own failure when the container cannot be
   * reached or the command never took over the terminal.
   */
  abstract openPty(options: ContainerPtyOptions): Promise<ContainerPtySession>
}

export default ContainerRuntime
