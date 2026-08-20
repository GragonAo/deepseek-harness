/**
 * Versionless cross-process wire protocol between the co-shipped process
 * executor (host) and the execution worker (process), NDJSON over stdio: one
 * JSON object per line. The host re-validates every inbound frame field by
 * field — the worker and host are co-shipped, but a frame still arrives as
 * untrusted JSON.
 *
 * @module @deepseek-ai/dsh-tool-executor-process/protocol
 */

import type { ToolExecutionFailure, ToolExecutionValue } from '@deepseek-ai/dsh-tool-executor'

/** Host → worker: run one body by its stable control-plane name. */
export interface CallMessage {
  readonly type: 'call'
  /** Host-issued correlation id; the worker answers each id at most once. */
  readonly id: number
  /** The tool's stable control-plane name, resolved against the worker's own body registry. */
  readonly name: string
  /** Canonical lossless-JSON arguments. */
  readonly arguments: ToolExecutionValue
}

/** Host → worker: cancel the in-flight call with this id. */
export interface AbortMessage {
  readonly type: 'abort'
  readonly id: number
}

/** Every message the host sends. */
export type HostToWorker = CallMessage | AbortMessage

/** Worker → host: the worker finished loading its body registry and is ready for calls. */
export interface ReadyMessage {
  readonly type: 'ready'
}

/** Worker → host: one call settled. Exactly one of `value` or `failure` is present. */
export interface ReplyMessage {
  readonly type: 'reply'
  readonly id: number
  /** The body's canonical value on a clean completion. */
  readonly value?: ToolExecutionValue
  /** The failure field on a body exception or abort; see {@link ToolExecutionFailure}. */
  readonly failure?: ToolExecutionFailure
}

/** Every message the worker sends. */
export type WorkerToHost = ReadyMessage | ReplyMessage
