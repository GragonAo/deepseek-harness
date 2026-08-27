/**
 * Host side of one container workflow run. The transport is the only
 * difference from the worker-thread engine: the run executes inside the tenant
 * tool-exec container over a per-run duplex HTTP bridge, so the "worker" is a
 * container process reached through `ctx.containerRuntime.exec`, not a
 * `node:worker_threads` Worker. The child RPC, cancellation, grace, disposal,
 * quiescence, and agent-pairing state machine is the same closed protocol the
 * worker-thread host drives; every terminal path also severs the bridge.
 * @module @deepseek-ai/dsh-workflow-container/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import {
  HostToWorkerType,
  WorkerToHostType,
  renderThrown,
} from '@deepseek-ai/dsh-workflow-worker-thread'
import type {
  ExecutionObserver,
  HostToWorkerMessage,
  HostToWorkerPayloads,
  WorkerToHostMessage,
} from '@deepseek-ai/dsh-workflow-worker-thread'
import type {
  ChildResult,
  ChildStartRequest,
  WorkerInit,
} from '@deepseek-ai/dsh-workflow-worker-thread'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
  WorkflowRunId,
} from '@deepseek-ai/dsh-workflow'
import { createWorkflowBridge } from './transport.ts'
import type { WorkflowBridge } from './transport.ts'

/** One published child and its shared quiescent-disposal transaction. */
interface ChildRecord {
  readonly run: SubagentRun
  disposal?: Promise<void>
}

/**
 * One live container-engine run — the seam's {@link WorkflowRun}, returned by
 * `start()` directly. Owns the container process, the bridge, the child
 * registry, and the result settlement; `result` never rejects. `meta` is
 * trusted same-process data borrowed as immutable by the handle and lifecycle
 * events. The holder-bound SubagentRuntime handle is captured before the
 * engine returns this run, so unloading the engine removes only the ability to
 * start another workflow; this run can still start and clean up its children.
 */
export class ContainerRun implements WorkflowRun {
  /** Settles exactly once with the run's outcome; never rejects. */
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  /** A Result/death/grace outcome atomically won before teardown callbacks. */
  private terminalClaimed = false
  private cancelReason: string | undefined
  private graceTimer: NodeJS.Timeout | undefined
  /** Set when the container process is gone; posting into the bridge is pointless afterward. */
  private workerGone = false
  /** The first death signal was processed; the one-time settlement/teardown ran. */
  private workerDeathObserved = false
  /** Accepted `child-start` messages — the terminate-path `agentsStarted` (see module doc). */
  private hostStarted = 0
  /** Published children by callId; an entry leaves only after disposal settles. */
  private readonly children = new Map<number, ChildRecord>()
  /** Provider starts that have not yet fulfilled or rejected. */
  private readonly pendingStarts = new Set<Promise<void>>()
  /** Started-but-not-ended agents by seq — the pairing ledger the HOST guarantees (see {@link endAgent}). */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private readonly quiescenceWaiters: (() => void)[] = []
  /** The per-run abort fanout every child start request carries. */
  private readonly controller = new AbortController()
  /** The exec signal that terminates the container process on grace/teardown. */
  private readonly execController = new AbortController()
  /** External start signal and the exact callback installed on it, retained only until first settle/teardown. */
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private disposed: Promise<void> | undefined
  /** The duplex bridge, set before the container spawn; severed only once the process is gone. */
  private bridge: WorkflowBridge | undefined

  constructor(
    private readonly ctx: Context,
    private readonly containerRuntime: ContainerRuntime,
    private readonly subagents: SubagentRuntime,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    private readonly init: WorkerInit,
    private readonly provider: string,
    private readonly disposeGraceMs: number,
    private readonly observer: ExecutionObserver,
    private readonly workerBundle: string,
    private readonly hostBridge: string,
    signal: AbortSignal | undefined,
  ) {
    this.result = new Promise<WorkflowResult>((resolve) => { this.settleResolve = resolve })
    void this.spawn()
    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = signal
      this.inputSignalAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  /**
   * Stand up the bridge, run the worker bundle inside the tenant container,
   * and treat its settlement as worker death. The init payload rides the
   * `DSH_WORKFLOW_INIT` env var (its JSON encode is the caller-isolation copy);
   * the bundle rides stdin under `node --input-type=module -`, because the
   * bundle exceeds Linux's single-argument ceiling (`-e` carries it only as one
   * argv entry, which `spawn` rejects with `E2BIG`). Never rejects.
   */
  private async spawn(): Promise<void> {
    try {
      this.bridge = await createWorkflowBridge((message) => { this.onMessage(message) }, this.hostBridge)
      const executed = await this.containerRuntime.exec('node', ['--input-type=module', '-'], {
        stdin: this.workerBundle,
        env: { DSH_WORKFLOW_BRIDGE: this.bridge.url, DSH_WORKFLOW_INIT: JSON.stringify(this.init) },
        signal: this.execController.signal,
      })
      this.workerGone = true
      this.onWorkerDeath(`workflow worker exited before the run settled (exit code ${executed.exitCode})`, true)
    } catch (error: unknown) {
      this.workerGone = true
      // An abort (grace/teardown) is the intended termination, not an unexpected
      // failure; the state machine already won the outcome before the abort.
      this.onWorkerDeath(`workflow worker failed: ${renderThrown(error)}`, false)
    } finally {
      await this.bridge?.close()
    }
  }

  /**
   * Cancel the run: the worker is told (its hooks start throwing and the
   * script dies at its next await), the required signal shared by every child
   * start is aborted, and the grace timer arms: a run still unsettled
   * `disposeGraceMs` later force-settles `cancelled` and its container process
   * is aborted. Idempotent; the first reason wins.
   * @param reason - human-readable cause (default `'workflow cancelled'`).
   */
  cancel(reason?: string): void {
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.post(HostToWorkerType.Cancel, { reason: this.cancelReason })
    this.abortChildren(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      this.terminalClaimed = true
      this.endStrandedAgents()
      this.settleResult(this.cancelledResult(this.hostStarted))
      this.execController.abort()
    }, this.disposeGraceMs)
    this.graceTimer.unref()
  }

  /**
   * Cancel + bounded settle + termination. Host-drives every registered child's
   * disposal IMMEDIATELY (a wedged worker can relay no dispose RPC), so child
   * disposal overlaps the same grace the worker gets to settle; then aborts the
   * container process unconditionally and reaps whatever children remain.
   * Idempotent; safe on every path.
   * @returns resolves when the run's resources are released or abandoned.
   */
  dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed
    const claimed = Promise.withResolvers<undefined>()
    this.disposed = claimed.promise
    void (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      this.reapChildren('workflow disposed')
      await Promise.race([
        (async () => {
          await this.result
          await this.childQuiescence()
        })(),
        sleep(this.disposeGraceMs),
      ])
      this.execController.abort()
      this.reapChildren('workflow disposed')
    })().then(
      () => { claimed.resolve(undefined) },
      /* v8 ignore next -- result/quiescence never reject and abort is the only external side effect */
      (error: unknown) => { claimed.reject(error) },
    )
    return this.disposed
  }

  /** Post one host-side message into the bridge's long-poll queue, tolerating a process that is already gone. */
  private post<T extends HostToWorkerType>(type: T, payload: HostToWorkerPayloads[T]): void {
    if (this.workerGone) return
    this.bridge?.post({ type, ...payload } as HostToWorkerMessage)
  }

  private onMessage(message: WorkerToHostMessage): void {
    // The first death signal is the host's logical delivery barrier: nothing
    // arriving afterward may create a child or narrate after workflow/end.
    if (this.workerGone) return
    switch (message.type) {
      case WorkerToHostType.Ready:
        this.post(HostToWorkerType.Go, {})
        break
      case WorkerToHostType.Phase:
        if (this.cancelReason === undefined) this.observer.phase(message.title)
        break
      case WorkerToHostType.Log:
        if (this.cancelReason === undefined) this.observer.log(message.message)
        break
      case WorkerToHostType.AgentStart:
        this.liveAgents.set(message.info.seq, message.info)
        this.observer.agentStart(message.info)
        break
      case WorkerToHostType.AgentEnd:
        this.endAgent(message.info)
        break
      case WorkerToHostType.ChildStart:
        this.onChildStart(message.callId, message.request)
        break
      case WorkerToHostType.ChildDispose:
        this.onChildDispose(message.callId)
        break
      case WorkerToHostType.Result:
        this.onResult(message.result)
        break
      /* v8 ignore next 2 -- closed engine-owned union; the arm only makes adding a message type a compile error */
      default:
        assertNever(message, 'worker-to-host message')
    }
  }

  /** Why a ready provider result may no longer be admitted to the worker. */
  private childAdmissionFailure(): { reason: string; rendered: string } | undefined {
    if (this.cancelReason !== undefined) {
      return { reason: this.cancelReason, rendered: `workflow run cancelled: ${this.cancelReason}` }
    }
    if (this.workerGone) {
      return { reason: 'workflow worker gone', rendered: 'workflow worker is no longer available' }
    }
    if (this.terminalClaimed) {
      return { reason: 'workflow settled', rendered: 'workflow run already settled' }
    }
    return undefined
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    const initialFailure = this.childAdmissionFailure()
    if (initialFailure !== undefined) {
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: initialFailure.rendered })
      return
    }
    this.hostStarted += 1
    const task = this.startChild(callId, request)
    this.pendingStarts.add(task)
    void task.then(
      () => { this.finishPendingStart(task) },
      /* v8 ignore next -- startChild contains provider and cleanup failures */
      () => { this.finishPendingStart(task) },
    )
  }

  /** Await one provider-owned startup transaction and publish only while admitted. */
  private async startChild(callId: number, request: ChildStartRequest): Promise<void> {
    let run: SubagentRun
    try {
      run = await this.subagents.start(this.provider, {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: this.parent,
        signal: this.controller.signal,
        ...request.schema !== undefined ? { outputSchema: request.schema } : {},
        ...request.provider !== undefined || request.model !== undefined
          ? {
            agentOptions: {
              ...request.provider !== undefined ? { provider: request.provider } : {},
              ...request.model !== undefined ? { model: request.model } : {},
            },
          }
          : {},
      })
    } catch (error: unknown) {
      const failure = this.childAdmissionFailure()
      this.post(HostToWorkerType.ChildStartError, {
        callId,
        rendered: failure?.rendered ?? renderThrown(error),
      })
      return
    }
    const failure = this.childAdmissionFailure()
    if (failure !== undefined) {
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: failure.rendered })
      try {
        await run.dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow-container: refused child dispose failed: ${renderThrown(error)}`)
      }
      return
    }

    const record: ChildRecord = { run }
    this.children.set(callId, record)
    const forwardResult = run.result.then<() => void, () => void>(
      (result) => {
        try {
          const snapshot = snapshotJsonValue<ChildResult>({
            output: result.output,
            ...result.structured !== undefined ? { structured: result.structured } : {},
            stopReason: result.stopReason,
          })
          if (snapshot === undefined) throw new TypeError('child result is not losslessly JSON-serializable')
          return () => { this.post(HostToWorkerType.ChildSettled, { callId, result: snapshot }) }
        } catch (error: unknown) {
          const rendered = `workflow child result could not cross the bridge: ${renderThrown(error)}`
          return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
        }
      },
      (error: unknown) => {
        const rendered = renderThrown(error)
        return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
      },
    )
    this.post(HostToWorkerType.ChildStarted, { callId, childId: run.id })
    void forwardResult.then((forward) => { forward() })
  }

  private onChildDispose(callId: number): void {
    const record = this.children.get(callId)
    if (record === undefined) {
      this.post(HostToWorkerType.ChildDisposed, { callId })
      return
    }
    void this.disposeChild(callId, record).then(() => { this.post(HostToWorkerType.ChildDisposed, { callId }) })
  }

  /**
   * Start (or join) one registered child's disposal; the registry entry leaves
   * when it settles. Memoized per callId; a rejection is contained (logged) and
   * the child still leaves the registry.
   */
  private disposeChild(callId: number, record: ChildRecord): Promise<void> {
    if (record.disposal !== undefined) return record.disposal
    record.disposal = Promise.resolve()
      .then(() => record.run.dispose())
      .catch((error: unknown) => {
        this.ctx.logger.warn(`workflow-container: child dispose failed: ${renderThrown(error)}`)
      })
      .then(() => { this.finishChild(callId) })
    return record.disposal
  }

  /** Drop a child record and release quiescence waiters when all work ends. */
  private finishChild(callId: number): void {
    this.children.delete(callId)
    this.notifyChildQuiescence()
  }

  /** Retire one provider startup transaction. */
  private finishPendingStart(task: Promise<void>): void {
    this.pendingStarts.delete(task)
    this.notifyChildQuiescence()
  }

  /** Release waiters only after both pending starts and published children end. */
  private notifyChildQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts.size !== 0) return
    for (const waiter of this.quiescenceWaiters.splice(0)) waiter()
  }

  /** Resolves once every pending start and published child has reached quiescence. */
  private childQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts.size === 0) return Promise.resolve()
    return new Promise((resolve) => { this.quiescenceWaiters.push(resolve) })
  }

  /** Abort + dispose every registered child (worker death / final teardown); disposal is contained, not awaited. */
  private reapChildren(reason: string): void {
    this.abortChildren(this.cancelReason ?? reason)
    for (const [callId, record] of [...this.children]) {
      void this.disposeChild(callId, record)
    }
  }

  /** Abort the one canonical signal shared by pending and published children. */
  private abortChildren(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private onResult(result: WorkflowResult): void {
    if (this.terminalClaimed) return
    const cancellationWasRequested = this.cancelReason !== undefined
    this.terminalClaimed = true
    this.reapChildren('workflow settled')
    if (!cancellationWasRequested) {
      this.settleResult(result)
      return
    }
    if (result.stopReason !== 'cancelled') {
      this.settleResult(this.cancelledResult(result.agentsStarted))
      return
    }
    this.settleResult(result)
  }

  /** Process a container-process settlement signal; the physical exit also performs the final disposal sweep. */
  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      this.workerDeathObserved = true
      const outcomeWasClaimed = this.terminalClaimed
      const cancellationWasRequested = this.cancelReason !== undefined
      if (!outcomeWasClaimed) this.terminalClaimed = true
      if (this.children.size > 0 || this.pendingStarts.size > 0) this.reapChildren('workflow worker gone')
      this.endStrandedAgents()
      if (!outcomeWasClaimed) {
        if (cancellationWasRequested) {
          this.settleResult(this.cancelledResult(this.hostStarted))
        } else {
          this.settleResult({ value: null, stopReason: 'error', error: message, agentsStarted: this.hostStarted })
        }
      }
    }
    if (!isExit) return
    for (const [callId, record] of [...this.children]) void this.disposeChild(callId, record)
    this.endStrandedAgents()
  }

  /** The single agent-end emission gate (see the worker-thread host for the pairing contract). */
  private endAgent(end: WorkflowAgentEndInfo): void {
    /* v8 ignore next -- a real end still in flight across the grace force-settle: not orderable in-process */
    if (!this.liveAgents.delete(end.seq)) return
    this.observer.agentEnd(end)
  }

  /** Synthesize the missing `agent-end` for every started-but-unpaired agent, outcome `'cancelled'`. */
  private endStrandedAgents(): void {
    for (const info of [...this.liveAgents.values()]) {
      this.endAgent({ ...info, outcome: 'cancelled' })
    }
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    /* v8 ignore next */
    const reason = this.cancelReason ?? 'workflow cancelled'
    return { value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${reason}`, agentsStarted }
  }

  /** Remove the exact abort callback installed on the caller's start signal. */
  private detachInputSignal(): void {
    const signal = this.inputSignal
    const onAbort = this.inputSignalAbort
    if (signal === undefined || onAbort === undefined) return
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
    signal.removeEventListener('abort', onAbort)
  }

  /** First settle wins; disarms the grace timer and releases the caller signal. */
  private settleResult(result: WorkflowResult): void {
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
    clearTimeout(this.graceTimer)
    this.settleResolve(result)
  }
}

/** A plain timer sleep (the dispose grace); unref'd so it never holds the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
