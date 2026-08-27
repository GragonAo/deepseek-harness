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
  /** Captured stdout, decoded as UTF-8. */
  stdout: string
  /** Captured stderr, decoded as UTF-8. */
  stderr: string
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
}

export default ContainerRuntime
