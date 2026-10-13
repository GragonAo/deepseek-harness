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
   *
   * 子进程不再读 stdin 的调用仍以它的退出码与已捕获输出结算：子进程自己的结局就是这次调用的答案，
   * 而喂 stdin 的 `kubectl create -f -` 那个 Pod 可能已经建成。
   * @param args - subcommand and arguments for that binary.
   * @param opts - optional stdin feed and cancellation.
   * @returns the command's exit code and captured stdout/stderr.
   * @throws 二进制拉不起来时，或喂 stdin 出了「子进程关掉自己的输入」之外的错时。
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

/**
 * 子进程 stdin 上报「它已经关掉自己的输入」这一类写入错误的错误码：子进程提前退出时它的 stdin
 * 读端随之关闭，剩下没送完的写入于是失败——POSIX 报 `EPIPE`，Windows 经 libuv 报 `EOF`，
 * 两端都消失时还可能报 `ECONNRESET`。三者都只说明子进程不再读输入，与这次调用是否失败无关。
 */
const CLOSED_STDIN_CODES: ReadonlySet<NodeJS.ErrnoException['code']> = new Set(['EPIPE', 'EOF', 'ECONNRESET'])

function isClosedStdin(error: unknown): boolean {
  return CLOSED_STDIN_CODES.has((error as NodeJS.ErrnoException).code)
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
    // 只接管 stdin 这条流，不把整个调用包进 try：能到达这里的只有这条管道的写入错误。吞掉的是
    // 「子进程已经关掉自己的输入」这一种——它的退出码与已捕获输出才是这次调用的答案，而被喂 stdin
    // 的正是 `kubectl create -f -`，这时那个 Pod 可能已经建成，不能因为管道写不完就当它失败；没有
    // 这个监听时，被吞掉的那一种是未处理流错误，它会打死整个宿主进程。其余错误码一律交给调用方
    // 看见，并带上跑的是哪一个二进制。
    child.stdin.on('error', (error: Error) => {
      if (isClosedStdin(error)) return
      reject(new Error(`container-transport: writing the stdin of '${binary}' failed: ${error.message}`))
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
