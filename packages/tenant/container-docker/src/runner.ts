/**
 * CLI runner seam for the tenant-scoped container provider: run one
 * docker/podman command and capture its exit code and streams. Abstracted so
 * the provider's mount and routing logic is unit-tested without a live
 * container runtime.
 * @module @deepseek-ai/dsh-container-docker/src/runner
 */

import { spawn } from 'node:child_process'
import type { ContainerCommandResult, ContainerExecOptions } from '@deepseek-ai/dsh-container'

/** One runnable container CLI surface (production: the docker/podman binary). */
export interface DockerRunner {
  /**
   * Run one CLI command (the arguments after the runtime binary).
   * @param args - docker/podman subcommand and arguments.
   * @param opts - optional stdin feed and cancellation.
   * @returns the command's exit code and captured stdout/stderr.
   */
  run(args: readonly string[], opts?: ContainerExecOptions): Promise<ContainerCommandResult>
}

/**
 * Attach a runner to one container-runtime binary.
 * @param runtime - `docker` or `podman`.
 * @returns the runner that invokes that binary.
 */
export function cliRunner(runtime: string): DockerRunner {
  return { run: (args, opts) => runCli(runtime, args, opts) }
}

function runCli(
  runtime: string,
  args: readonly string[],
  opts?: ContainerExecOptions,
): Promise<ContainerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    const onAbort = () => child.kill('SIGKILL')
    opts?.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('close', (code) => {
      opts?.signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    if (opts?.stdin !== undefined) {
      child.stdin.write(opts.stdin)
    }
    child.stdin.end()
  })
}
