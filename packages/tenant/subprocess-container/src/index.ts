/**
 * Container provider for the subprocess capability seam (`ctx.subprocess`).
 * `resolveExecutable` and `spawn` run against the ambient tenant's container
 * (the same execution world the filesystem provider serves), so a tool's
 * process never leaves the tenant's isolation boundary.
 * @module @deepseek-ai/dsh-subprocess-container
 */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ContainerExecOptions, ContainerRuntime } from '@deepseek-ai/dsh-container'

/** Quote one word for the unavoidable `/bin/sh -c` lookup layer. */
function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/** Omit the signal field when absent (exact-optional-property safe). */
function signalOpts(signal: AbortSignal | undefined): ContainerExecOptions {
  return signal === undefined ? {} : { signal }
}

function definedEnv(env: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/** Bounded captured-stream reader; settled once the captured exec returns. */
class CapturedReader implements SubprocessOutputReader {
  private text = ''
  private truncated = false
  private totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  settle(full: string): void {
    this.totalBytes = Buffer.byteLength(full, 'utf8')
    const buf = Buffer.from(full, 'utf8')
    if (buf.length <= this.maxBytes) {
      this.text = full
      this.truncated = false
    } else {
      this.text = buf.subarray(buf.length - this.maxBytes).toString('utf8')
      this.truncated = true
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    if (this.truncated && fromByte <= 0) {
      return { text: this.text, nextOffset: this.totalBytes, lossy: true }
    }
    if (fromByte >= this.totalBytes) {
      return { text: '', nextOffset: this.totalBytes, lossy: false }
    }
    const retained = Buffer.from(this.text, 'utf8')
    const start = fromByte <= 0
      ? 0
      : Math.min(Math.max(0, fromByte - (this.totalBytes - retained.length)), retained.length)
    return { text: retained.subarray(start).toString('utf8'), nextOffset: this.totalBytes, lossy: false }
  }
}

/** One captured-exec process handle (no live streaming in this slice). */
class ContainerSubprocessHandle implements SubprocessHandle {
  readonly pid = -1
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader } = {}
  readonly done: Promise<SubprocessOutcome>

  private readonly stdoutReader: CapturedReader | undefined
  private readonly stderrReader: CapturedReader | undefined

  constructor(runtime: ContainerRuntime, spec: SubprocessSpawnSpec) {
    if (typeof spec.stdio.stdout !== 'string') {
      this.stdoutReader = new CapturedReader(spec.stdio.stdout.maxBytes)
      this.collected.stdout = this.stdoutReader
    }
    if (typeof spec.stdio.stderr !== 'string') {
      this.stderrReader = new CapturedReader(spec.stdio.stderr.maxBytes)
      this.collected.stderr = this.stderrReader
    }
    const program = spec.argv[0]
    if (program === undefined || program === '') {
      throw new Error('subprocess-container: argv must name a program')
    }
    const stdinData = spec.stdio.stdin === 'ignore' || spec.stdio.stdin === 'pipe'
      ? undefined
      : spec.stdio.stdin.data
    const execOpts: ContainerExecOptions = { cwd: spec.cwd }
    const env = definedEnv(spec.env)
    if (Object.keys(env).length > 0) execOpts.env = env
    if (stdinData !== undefined) execOpts.stdin = stdinData
    if (spec.signal !== undefined) execOpts.signal = spec.signal
    const running = runtime.exec(program, spec.argv.slice(1), execOpts)
    void running.then((result) => {
      this.stdoutReader?.settle(result.stdout)
      this.stderrReader?.settle(result.stderr)
    }, () => {})
    this.done = running.then(result => ({ exitCode: result.exitCode, signal: null }))
  }

  terminate(): void {
    // The slice's captured exec runs to completion with no live tree to signal.
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    if (signal === undefined) {
      await this.done
      return true
    }
    const aborted = new Promise<false>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve(false)
      }, { once: true })
    })
    const finished = this.done.then(() => true)
    return Promise.race([aborted, finished])
  }
}

/** Container subprocess service registered as `ctx.subprocess`. */
export class ContainerSubprocessRuntime extends SubprocessRuntime {
  static inject = ['containerRuntime']

  resolveExecutable(
    command: string,
    _env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()
    if (command === '') {
      return Promise.reject(new Error('subprocess-container: empty command'))
    }
    return this.resolve(command, signal)
  }

  private async resolve(command: string, signal: AbortSignal | undefined): Promise<string> {
    const runtime = this.ctx.containerRuntime
    if (posix.isAbsolute(command)) {
      // An absolute command starts with '/', so it can never parse as a `test`
      // option: the `--` end-of-options marker that bash's test accepts is an
      // "unexpected operator" in dash, the default `/bin/sh` of the tool-exec
      // container, so omit it.
      const result = await runtime.exec('sh', ['-c', `test -x ${quoteShell(command)}`], signalOpts(signal))
      if (result.exitCode !== 0) {
        throw new Error(`subprocess-container: '${command}' is not an executable file`)
      }
      return command
    }
    const result = await runtime.exec('sh', ['-c', `command -v -- ${quoteShell(command)}`], signalOpts(signal))
    const found = result.stdout.trim()
    if (result.exitCode !== 0 || found === '') {
      throw new Error(`subprocess-container: executable '${command}' not found`)
    }
    return found
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const { stdin, stdout, stderr } = spec.stdio
    if (stdin === 'pipe' || stdout === 'pipe' || stderr === 'pipe') {
      throw new Error('subprocess-container: piped stdio is not supported in the vertical slice; use collect or ignore')
    }
    return new ContainerSubprocessHandle(this.ctx.containerRuntime, spec)
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('subprocess-container: spawnTerminal is not supported in the vertical slice'))
  }
}

export default ContainerSubprocessRuntime
