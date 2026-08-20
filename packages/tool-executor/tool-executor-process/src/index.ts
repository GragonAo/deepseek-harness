/**
 * Process implementation of the tool-execution seam: run each tool body in its
 * own execution worker — a forked Node process speaking a stdio NDJSON
 * protocol — and report the canonical value back. This is the first real
 * agent-plane/execution-plane split: the body no longer runs beside session,
 * agent, and credential state, though a bare process (not a sandboxed one) is
 * still containment, not a security boundary.
 *
 * @module @deepseek-ai/dsh-tool-executor-process
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { ToolExecutor } from '@deepseek-ai/dsh-tool-executor'
import type { ToolExecutionFailure, ToolExecutionOutcome, ToolExecutionRequest } from '@deepseek-ai/dsh-tool-executor'
import type { HostToWorker, WorkerToHost } from './protocol.ts'

/** Plugin config: every execution cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /** How long to wait for the worker's `ready` frame before failing the substrate, in milliseconds. */
  startupMs?: number
  /** Wall-clock ceiling per execution, in milliseconds; on expiry the call is aborted outward and reported. */
  executionMs?: number
}

/** {@link Config} after schemastery fills the defaults (every field present). */
type ResolvedConfig = Required<Config>

/** One host-side in-flight call, tracked for disposal and teardown. */
interface PendingCall {
  settle(outcome: ToolExecutionOutcome): void
}

/** The worker child: piped stdin/stdout for the protocol, inherited stderr for diagnostics. */
type WorkerChild = ChildProcessByStdio<Writable, Readable, null>

/**
 * Spawn the execution worker. Built consumers launch the bundled CJS entry next
 * to this module under plain node; unbuilt (source) consumers bootstrap tsx
 * first, mirroring the dsh CLI's source launch.
 */
function spawnWorker(): WorkerChild {
  // The tuple gives spawn's stdio overload the non-null stdin/stdout it types.
  const options = { stdio: ['pipe', 'pipe', 'inherit'] as ['pipe', 'pipe', 'inherit'], windowsHide: true }
  if (import.meta.url.endsWith('.ts')) {
    return spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./worker.ts', import.meta.url))], options)
  }
  return spawn(process.execPath, [fileURLToPath(new URL('./worker.cjs', import.meta.url))], options)
}

/**
 * Re-validate one inbound worker frame field by field. The worker is
 * co-shipped, but its stderr comes straight from a JSON line: a forged extra
 * field never rides along, an unknown message type drops, and a failed parse is
 * ignored without throwing (a throw in the `data` listener would crash the host).
 */
function parseWorkerMessage(line: string): WorkerToHost | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const message = raw as Record<string, unknown>
  if (message.type === 'ready') return { type: 'ready' }
  if (message.type === 'reply') {
    if (typeof message.id !== 'number') return undefined
    if (message.failure !== undefined) {
      if (typeof message.failure !== 'object' || message.failure === null) return undefined
      const { kind, message: detail } = message.failure as Record<string, unknown>
      if ((kind !== 'exception' && kind !== 'abort' && kind !== 'invalid-output' && kind !== 'execution-substrate') || typeof detail !== 'string') {
        return undefined
      }
      return { type: 'reply', id: message.id, failure: { kind, message: detail } }
    }
    // JSON.parse already guarantees `value` is lossless-JSON whenever present.
    return { type: 'reply', id: message.id, ...message.value !== undefined ? { value: message.value as import('@deepseek-ai/dsh-tool-executor').ToolExecutionValue } : {} }
  }
  return undefined
}

/**
 * The shipped {@link ToolExecutor} backend (`ctx.toolExecutor`). One standing
 * worker serves many executions; the body-registry resolution happens name-keyed
 * on the worker side (no function crosses the boundary). Disposal fails every
 * in-flight call as aborted and terminates the worker.
 */
export class ProcessToolExecutor extends ToolExecutor {
  static Config: z<Config> = z.object({
    startupMs: z.number().default(30_000),
    executionMs: z.number().default(600_000),
  })

  readonly isolation = 'process'

  private readonly config: ResolvedConfig
  private readonly child: WorkerChild
  private readonly pending = new Map<number, PendingCall>()
  private readonly ready: Promise<void>
  /** Set once the worker fails to start (spawn error, early exit, or startup timeout). */
  private workerStartupError: Error | undefined
  private nextId = 1
  private disposed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    // Schemastery filled the defaults; the cast records that. Positivity is a
    // semantic check the schema's plain number type does not carry.
    this.config = config as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (!(Number.isFinite(value) && value > 0)) throw new Error(`dsh-tool-executor-process: config.${key} must be a positive number, got ${String(value)}`)
    }
    this.child = spawnWorker()

    this.ready = new Promise<void>((resolve) => {
      let readySettled = false
      const settleReady = (): void => {
        if (readySettled) return
        readySettled = true
        clearTimeout(startupTimer)
        resolve()
      }
      const startupTimer = setTimeout(() => {
        this.workerStartupError = new Error(`dsh-tool-executor-process: worker did not answer ready within ${this.config.startupMs}ms`)
        settleReady()
      }, this.config.startupMs)

      let buffer = ''
      this.child.stdout.setEncoding('utf8')
      this.child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let index: number
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line) continue
          const message = parseWorkerMessage(line)
          if (!message) continue
          if (message.type === 'ready') {
            settleReady()
            continue
          }
          const call = this.pending.get(message.id)
          if (call === undefined) continue
          this.pending.delete(message.id)
          call.settle(message)
        }
      })

      this.child.on('error', (error: Error) => {
        this.workerStartupError = new Error(`dsh-tool-executor-process: worker spawn failed: ${error.message}`)
        settleReady()
      })
      this.child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = `worker exited (code ${String(code)}, signal ${String(signal)}) before completing`
        this.workerStartupError = new Error(`dsh-tool-executor-process: ${detail}`)
        settleReady()
        const failure: ToolExecutionFailure = { kind: 'execution-substrate', message: detail }
        for (const call of this.pending.values()) call.settle({ failure })
        this.pending.clear()
      })
    })

    ctx.effect(() => () => this.teardown(), 'process tool-executor teardown')
  }

  /**
   * Run one body in the worker. A pre-aborted request fails without ever
   * leaving the host; a live abort forwards an `abort` frame; expiry times the
   * call out; worker death reports an execution-substrate failure.
   * @param request - the tool name, validated arguments, and abort signal.
   */
  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    if (this.disposed) throw new Error('dsh-tool-executor-process: execute() after disposal')
    await this.ready
    if (this.workerStartupError !== undefined) {
      return { failure: { kind: 'execution-substrate', message: this.workerStartupError.message } }
    }
    if (request.signal.aborted) {
      return { failure: { kind: 'abort', message: String(request.signal.reason ?? 'tool call aborted') } }
    }

    const id = this.nextId++
    return new Promise<ToolExecutionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.send({ type: 'abort', id })
        settle({ failure: { kind: 'abort', message: `execution exceeded ${this.config.executionMs}ms` } })
      }, this.config.executionMs)
      const onAbort = (): void => {
        this.send({ type: 'abort', id })
      }
      const settle = (outcome: ToolExecutionOutcome): void => {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        resolve(outcome)
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { settle })
      this.send({ type: 'call', id, name: request.name, arguments: request.arguments })
    })
  }

  private send(frame: HostToWorker): void {
    try {
      this.child.stdin.write(JSON.stringify(frame) + '\n')
    } catch {
      // The exit handler already settles in-flight calls as substrate failures.
    }
  }

  /** Dispose to quiescence: mark unusable, fail in-flight calls, terminate the worker, and await its exit. */
  private async teardown(): Promise<void> {
    this.disposed = true
    const failure: ToolExecutionFailure = { kind: 'abort', message: 'process tool executor disposed' }
    for (const call of this.pending.values()) call.settle({ failure })
    this.pending.clear()
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill()
      await new Promise<void>((resolve) => { this.child.once('exit', () => { resolve() }) })
    }
  }
}

export default ProcessToolExecutor
