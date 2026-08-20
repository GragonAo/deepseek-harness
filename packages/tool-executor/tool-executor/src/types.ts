/**
 * Vocabulary for the tool-execution seam: what the tool registry hands an
 * execution world and what it gets back. Pure types — no runtime code lives
 * here.
 *
 * @module @deepseek-ai/dsh-tool-executor/types
 */

import type { ToolBodyId } from './brand.ts'

/**
 * A lossless JSON value transferable across the execution boundary. The
 * structural equivalent of the session's canonical `JsonValue`, kept local so
 * this Service Definition stays independent of sessions (the `CodeJsonValue`
 * precedent in dsh-code-runtime).
 */
export type ToolExecutionValue =
  | null
  | boolean
  | number
  | string
  | ToolExecutionValue[]
  | { [key: string]: ToolExecutionValue }

/**
 * What one execution body sees while it runs. Only the abort signal crosses
 * into the execution world — no agent, no session, no approval channel, no
 * registry context — so a body cannot reach agent-plane state.
 */
export interface ToolBodyContext {
  /** Abort the body; a provider maps this onto the execution world's cancel path. */
  readonly signal: AbortSignal
}

/**
 * One executable tool body: canonical lossless-JSON arguments in, canonical
 * lossless-JSON value out. The tool registry owns argument and output
 * validation; the body only runs.
 */
export type ToolBody = (args: ToolExecutionValue, ctx: ToolBodyContext) => Promise<ToolExecutionValue>

/**
 * Why a body execution failed. The kinds are orthogonal outcomes reported
 * independently (per docs/defensive-patterns.md): an exception is not an abort,
 * and a dead execution substrate is neither.
 *
 * - `'exception'` — the body threw.
 * - `'abort'` — {@link ToolExecutionRequest.signal} fired.
 * - `'invalid-output'` — the returned value was not lossless JSON.
 * - `'execution-substrate'` — the execution world died without settling.
 */
export interface ToolExecutionFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'abort' | 'invalid-output' | 'execution-substrate'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}

/**
 * One body execution request. Per the explicit-over-implicit convention,
 * defaulting (time budgets, output caps) is the provider's validated config —
 * a request carries no optional tuning knobs for a hidden `??` to fill in.
 */
export interface ToolExecutionRequest {
  /** Agent-plane diagnostic identity for this execution (per-body mint). */
  toolId: ToolBodyId
  /**
   * The tool's stable control-plane name. A cross-process world resolves this
   * against its own body registry — the {@link body} function cannot cross a
   * process boundary; `toolId` does not travel as a resolution key.
   */
  name: string
  /** The validated, losslessly snapshotted arguments. */
  arguments: ToolExecutionValue
  /** Cancel the execution; see {@link ToolBodyContext.signal}. */
  signal: AbortSignal
  /**
   * The body to run, supplied by the tool registry for execution in this
   * process. A cross-process world ignores it — a function cannot cross a
   * process boundary — and resolves {@link name} against its own registry.
   */
  body?: ToolBody
}

/**
 * The outcome of one body execution. A failure is a FIELD on a resolved
 * outcome, never a rejection of `execute()` — reporting a failed body is the
 * caller's job, not an exception path (the `CodeRunResult` contract).
 */
export interface ToolExecutionOutcome {
  /** The body's canonical value, when it ran to completion and crossed the lossless-JSON boundary. */
  value?: ToolExecutionValue
  /** Present iff the execution failed; see {@link ToolExecutionFailure}. */
  failure?: ToolExecutionFailure
}
