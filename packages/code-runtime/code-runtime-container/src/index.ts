/**
 * Container code runtime: runs each host-type-stripped TypeScript program inside
 * the ambient tenant's container (via `ctx.containerRuntime`) and bridges the
 * program's declared bindings over a short-lived, token-authenticated loopback
 * HTTP surface. The container holds only the tenant's bind-mounted workspace
 * and tools, so model code cannot touch host files, environment, or secrets
 * even if it escapes the program wrapper: isolation is the container boundary,
 * not JavaScript.
 * @module @deepseek-ai/dsh-code-runtime-container
 */

import { stripTypeScriptTypes } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodeRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-code-runtime'
import type { CodeBindingNamespace, CodeRunFailure, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import type { ContainerCommandResult } from '@deepseek-ai/dsh-container'
import { createBindingBridge } from './bridge.ts'
import { CONTAINER_BOOTSTRAP } from './bootstrap.ts'
import type { ContainerBootData, ContainerBootNamespace, ContainerResultFrame } from './bootstrap.ts'

/** Plugin config: every execution cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /** Wall-clock ceiling in milliseconds; aborts the exec when crossed (fires `timeout`). */
  maxWallMs?: number
  /** Hard cap for the serialized logs-plus-completion-value payload, enforced in the container. */
  maxOutputBytes?: number
  /** Hostname the container uses to reach the host bridge (Docker: `host.docker.internal`; Podman: `host.containers.internal`). */
  hostBridge?: string
}

/** {@link Config} after schemastery fills the defaults (every field present). */
type ResolvedConfig = Required<Config>

/** Smallest cap that can represent the counted payloads: an empty logs array plus an empty JSON failure message. */
const MIN_OUTPUT_BYTES = 4

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The grammar context the type-strip needs (top-level `return`/`await` are an async-function body). */
const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' } as const

/** The frame error kinds the in-container bootstrap can report; everything else the host reports. */
const FRAME_KINDS = new Set<CodeRunFailure['kind']>(['exception', 'invalid-output', 'output-limit'])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One in-flight run's host-side state, tracked for disposal. */
interface LiveRun {
  controller: AbortController
  finished: Promise<void>
}

/** Extract the last non-empty stdout line — the single JSON frame the bootstrap prints. */
function parseFrame(stdout: string): ContainerResultFrame | undefined {
  const trimmed = stdout.trimEnd()
  if (trimmed === '') return undefined
  const lastNewline = trimmed.lastIndexOf('\n')
  const line = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1)
  try {
    const parsed = JSON.parse(line) as ContainerResultFrame
    return Array.isArray(parsed.logs) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Render the container's non-zero-exit / no-frame outcome as a diagnostic. */
function exitDiagnostic(result: ContainerCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim()
  return `container exited with code ${result.exitCode}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ' without a result frame'}`
}

/**
 * The shipped {@link CodeRuntime} backend (registered as `ctx.codeRuntime`).
 * Programs run in the ambient tenant's container; binding calls bridge over
 * HTTP to the host. See the module doc for the isolation model.
 */
export class ContainerCodeRuntime extends CodeRuntime {
  static Config: z<Config> = z.object({
    maxWallMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    hostBridge: z.string().default('host.docker.internal'),
  })

  static inject = ['containerRuntime']

  readonly language = 'typescript'
  readonly isolation = 'container'

  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    if (!(Number.isFinite(this.config.maxWallMs) && this.config.maxWallMs > 0)) {
      throw new Error(`dsh-code-runtime-container: config.maxWallMs must be a positive number, got ${String(this.config.maxWallMs)}`)
    }
    if (!(Number.isFinite(this.config.maxOutputBytes) && this.config.maxOutputBytes > 0)) {
      throw new Error(`dsh-code-runtime-container: config.maxOutputBytes must be a positive number, got ${String(this.config.maxOutputBytes)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-code-runtime-container: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    if (this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-container: config.maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps a longer setTimeout delay to 1ms), got ${String(this.config.maxWallMs)}`)
    }
    ctx.effect(() => () => this.teardown(), 'container code-runtime teardown')
  }

  /** Dispose to quiescence: mark the service unusable and abort every in-flight run. */
  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.controller.abort()
    await Promise.all(runs.map(run => run.finished))
  }

  /**
   * Execute one program in the tenant container. Program outcomes resolve with
   * `result.error`; the method rejects only for Service Definition contract
   * misuse (a disposed runtime, an invalid binding namespace).
   * @param request - the program, its bindings, and the abort signal.
   * @returns the run's outcome per the seam contract.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-container: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
    }

    let code: string
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix)
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error: unknown) {
      return { logs: [], error: { kind: 'exception', message: messageOf(error) } }
    }

    const bridge = await createBindingBridge(bindings)
    const namespaces: ContainerBootNamespace[] = [...bindings].map(([global, namespace]) => ({
      global,
      names: Object.keys(namespace.functions),
      ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
    }))
    const bootData: ContainerBootData = { code, namespaces, maxOutputBytes: this.config.maxOutputBytes }

    const controller = new AbortController()
    let resolveFinished!: () => void
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve })
    const live: LiveRun = { controller, finished }
    this.live.add(live)
    let terminal: { kind: 'abort' | 'timeout'; message: string } | undefined
    const onAbort = (): void => {
      if (terminal !== undefined) return
      terminal = { kind: 'abort', message: String(request.signal?.reason) }
      controller.abort()
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const wallTimer = setTimeout(() => {
      if (terminal !== undefined) return
      terminal = { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }
      controller.abort()
    }, this.config.maxWallMs)

    let result: ContainerCommandResult
    try {
      result = await this.ctx.containerRuntime.exec('node', ['--input-type=module', '-e', CONTAINER_BOOTSTRAP], {
        stdin: JSON.stringify(bootData),
        env: { DSH_CODE_BRIDGE: `http://${this.config.hostBridge}:${bridge.port}/${bridge.token}` },
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (terminal !== undefined) return { logs: [], error: { kind: terminal.kind, message: terminal.message } }
      return { logs: [], error: { kind: 'worker-exit', message: `container exec failed: ${messageOf(error)}` } }
    } finally {
      clearTimeout(wallTimer)
      request.signal?.removeEventListener('abort', onAbort)
      this.live.delete(live)
      resolveFinished()
      await bridge.close()
    }

    if (terminal !== undefined) return { logs: [], error: { kind: terminal.kind, message: terminal.message } }

    const frame = parseFrame(result.stdout)
    if (frame === undefined) {
      return { logs: [], error: { kind: 'worker-exit', message: exitDiagnostic(result) } }
    }
    if (frame.error !== undefined) {
      const kind = FRAME_KINDS.has(frame.error.kind) ? frame.error.kind : 'worker-exit'
      const message = kind === 'worker-exit' ? `container reported unknown failure kind ${JSON.stringify(frame.error.kind)}` : frame.error.message
      return { logs: frame.logs, error: { kind, message } }
    }
    return { logs: frame.logs, ...frame.value !== undefined ? { value: frame.value } : {} }
  }

  /** Reject malformed binding globals or typed-error declarations as Service Definition contract misuse. */
  private validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-container: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-container: reserved binding global ${JSON.stringify(namespace.global)}`)
      }
      if (bindings.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-container: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      bindings.set(namespace.global, namespace)
    }

    const errorClassNames = new Set<string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (!descriptor) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-container: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-container: reserved binding global ${JSON.stringify(descriptor.name)}`)
      }
      if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-container: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-code-runtime-container: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return bindings
  }
}

export default ContainerCodeRuntime
