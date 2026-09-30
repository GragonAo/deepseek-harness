/**
 * CLI-launch seam for container-runtime providers: run one invocation of the
 * runtime's own binary and capture its exit code and streams. A provider's
 * mount, naming, and routing logic is unit-tested by injecting a fake, so this
 * is the one place that touches a child process.
 * @module @deepseek-ai/dsh-container-transport/cli-runner
 */

import { spawn } from 'node:child_process'
import type { ContainerCommandResult, ContainerExecOptions } from '@deepseek-ai/dsh-container'

/**
 * One runnable container-runtime CLI surface (production: the `docker`,
 * `podman`, or `kubectl` binary).
 */
export interface ContainerCliRunner {
  /**
   * Run one CLI command (the arguments after the runtime binary).
   * @param args - subcommand and arguments for that binary.
   * @param opts - optional stdin feed and cancellation.
   * @returns the command's exit code and captured stdout/stderr.
   */
  run(args: readonly string[], opts?: ContainerExecOptions): Promise<ContainerCommandResult>
}

/**
 * Attach a runner to one container-runtime binary.
 * @param binary - the executable to spawn, e.g. `docker` or `kubectl`.
 * @returns the runner that invokes that binary.
 */
export function cliRunner(binary: string): ContainerCliRunner {
  return { run: (args, opts) => runCli(binary, args, opts) }
}

function runCli(
  binary: string,
  args: readonly string[],
  opts?: ContainerExecOptions,
): Promise<ContainerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
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
