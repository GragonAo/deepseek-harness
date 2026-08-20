/**
 * Service Definition for the tool-execution capability seam: run one tool body
 * in an execution world and report its canonical value. Executors know nothing
 * about tools, sessions, policy, or the model; the tool registry (Consumer)
 * owns those concerns.
 *
 * @module @deepseek-ai/dsh-tool-executor
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolExecutionOutcome, ToolExecutionRequest } from './types.ts'

export { ToolBodyId } from './brand.ts'
export type {
  ToolBody,
  ToolBodyContext,
  ToolExecutionFailure,
  ToolExecutionOutcome,
  ToolExecutionRequest,
  ToolExecutionValue,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolExecutor: ToolExecutor
  }
}

/**
 * Registers one `ctx.toolExecutor` implementation. Body failures resolve in
 * {@link ToolExecutionOutcome}; only Service Definition contract misuse
 * rejects. Implementations treat bodies as the tool registry's trusted
 * execution-world counterpart, isolate executions from one another, and
 * terminate and await in-flight executions during disposal.
 */
export abstract class ToolExecutor extends Service {
  /**
   * The execution substrate, as a lowercase identifier. Informational, not
   * gating — a descriptor so deployments and diagnostics can tell providers
   * apart, not a security claim. Well-known values: `'in-process'`,
   * `'process'`, `'container'`.
   */
  abstract readonly isolation: string

  constructor(ctx: Context) {
    super(ctx, 'toolExecutor')
  }

  /**
   * Run one body in the execution world and capture its canonical value. The
   * outcome resolves with a `failure` FIELD for every execution failure; it
   * rejects only for caller misuse of the Service Definition contract (e.g. an
   * execution submitted after disposal).
   * @param request - the body to run, its validated arguments, and the abort
   *   signal; the request carries everything the execution acts on, with no
   *   hidden defaults. An in-process world receives the body inline
   *   (`request.body`); a cross-process world resolves the body from
   *   `request.toolId` in its own registry.
   * @returns the body's canonical value or failure.
   */
  abstract execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome>
}

export default ToolExecutor
