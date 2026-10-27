/**
 * Container provider for the subprocess capability seam (`ctx.subprocess`).
 * `resolveExecutable` and `spawn` run against the ambient tenant's container
 * (the same execution world the filesystem provider serves), so a tool's
 * process never leaves the tenant's isolation boundary.
 * @module @deepseek-ai/dsh-subprocess-container
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ContainerCommandResult, ContainerExecOptions, ContainerRuntime } from '@deepseek-ai/dsh-container'
import { sandboxSessionDir } from '@deepseek-ai/dsh-tenant'

/**
 * Container directory holding the marker file a write-effect scan compares
 * against. It is written and read inside the container only, so it needs no
 * mounted path and no host counterpart.
 */
const PRODUCE_MARKER_DIR = '/tmp'

/**
 * Bound on each write-effect observation exec (the marker probe and the scan).
 * It bounds an advisory side channel whose failure reports no produced files,
 * so it can never change a command's own outcome.
 */
const PRODUCE_PROBE_TIMEOUT_MS = 5_000

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

/**
 * Paths named by one completed scan. A capped capture keeps the TAIL of stdout,
 * so the first retained line may be a path fragment while every later line is
 * whole; the fragment is dropped rather than reported as a file.
 * @param result - the settled scan exec.
 * @returns one container-absolute path per reported file, in `find` order.
 */
function scanListing(result: ContainerCommandResult): readonly string[] {
  const lines = result.stdout.split('\n')
  if (result.stdoutTruncated === true) lines.shift()
  return lines.filter(line => line.length > 0)
}

/**
 * Write effects of one session-scoped command, observed on the container's own
 * clock: `begin` creates a marker file before the command starts, and `settle`
 * lists every regular file under the session directory whose modification time
 * is newer than that marker. Both steps run inside the container, so the report
 * needs no host path mapping. A file the command only read keeps its
 * modification time and is therefore never reported.
 */
class ProducedFilesScan {
  private readonly marker = posix.join(PRODUCE_MARKER_DIR, `.dsh-produce-${randomUUID()}`)
  private marked = false

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly sessionDir: string,
  ) {}

  /**
   * Create the marker this scan compares against, before the command starts. A
   * failed mark disables the report: `find -newer` needs the marker to exist, and
   * a command must not fail because its effects could not be observed.
   */
  async begin(): Promise<void> {
    try {
      const result = await this.runtime.exec('touch', [this.marker], {
        signal: AbortSignal.timeout(PRODUCE_PROBE_TIMEOUT_MS),
      })
      this.marked = result.exitCode === 0
    } catch {
      // The marker is this exec's only product: an aborted or unreachable
      // container leaves nothing to compare against and `marked` stays false.
    }
  }

  /**
   * List the files the command created or modified, then remove the marker.
   * @returns `{ produced }` with one container-absolute path per file, or `{}`
   *   when the scan could not answer or the command changed nothing.
   */
  async settle(): Promise<Pick<SubprocessOutcome, 'produced'>> {
    if (!this.marked) return {}
    // One exec carries the scan and the cleanup: a nonzero `find` exit is
    // reported as this script's exit code, and the marker is removed either way.
    const script = [
      `find ${quoteShell(this.sessionDir)} -type f -newer ${quoteShell(this.marker)} -printf '%p\\n'`,
      '__dsh_produce_status=$?',
      `rm -f ${quoteShell(this.marker)}`,
      'exit $__dsh_produce_status',
    ].join('; ')
    try {
      const result = await this.runtime.exec('sh', ['-c', script], {
        signal: AbortSignal.timeout(PRODUCE_PROBE_TIMEOUT_MS),
      })
      // A nonzero exit means the scan did not complete (a missing directory, an
      // expired bound): report nothing rather than a partial list that reads as
      // complete.
      if (result.exitCode !== 0) return {}
      const paths = scanListing(result)
      return paths.length === 0 ? {} : { produced: paths }
    } catch {
      // Same degradation as a nonzero exit: the command has already settled, and
      // an unobservable effect must not surface as a failure of the run.
      return {}
    }
  }
}

/** Bounded captured-stream reader; settled once the captured exec returns. */
class CapturedReader implements SubprocessOutputReader {
  private text = ''
  private truncated = false
  private totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  /**
   * 收下这次 exec 的结果。
   * @param full - 容器返回的整段文本（可能已经被容器侧上界截成末尾一段）。
   * @param containerTruncated - 容器是否已经丢掉了这条流的前缀；丢掉就再也补不回来，
   *   所以它必须让这次读取报 lossy，而不是让调用方以为读到的就是全部输出。
   */
  settle(full: string, containerTruncated: boolean): void {
    this.totalBytes = Buffer.byteLength(full, 'utf8')
    const buf = Buffer.from(full, 'utf8')
    if (buf.length <= this.maxBytes) {
      this.text = full
      this.truncated = containerTruncated
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

/**
 * One captured-exec process handle (no live streaming in this slice).
 *
 * 进程环境就是 `spec.env` 本身：受管 `DSH_*` 变量组由 `ctx.shellEnv` 这个唯一所有者
 * 组装，本 provider 只做透传，不自己拼一份列表，也不覆写调用方给的值。
 *
 * A command carrying a session identity also reports the files it created or
 * modified, on its settled `done`; see {@link ProducedFilesScan}.
 */
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
    // Write effects belong to a session: only a command carrying the session's
    // managed identity has a directory whose changes can be attributed to it.
    const sessionDir = sandboxSessionDir(env)
    const scan = sessionDir === undefined ? undefined : new ProducedFilesScan(runtime, sessionDir)
    const running = scan === undefined
      ? runtime.exec(program, spec.argv.slice(1), execOpts)
      : scan.begin().then(() => runtime.exec(program, spec.argv.slice(1), execOpts))
    void running.then((result) => {
      this.stdoutReader?.settle(result.stdout, result.stdoutTruncated === true)
      this.stderrReader?.settle(result.stderr, result.stderrTruncated === true)
    }, () => {})
    this.done = running.then(
      async result => ({
        exitCode: result.exitCode,
        signal: null,
        ...scan === undefined ? {} : await scan.settle(),
      }),
      async (error: unknown) => {
        // The exec never settled, so its write effects are unknown; settling the
        // scan here only removes the marker the probe created.
        await scan?.settle()
        throw error
      },
    )
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
