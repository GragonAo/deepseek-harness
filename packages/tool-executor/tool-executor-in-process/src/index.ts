/**
 * In-process implementation of the tool-execution seam: run the tool registry's
 * inline body in this same JavaScript realm. It is the verification backend of
 * the agent-plane/execution-plane split — the body executes here exactly as it
 * did before the seam existed — not an isolation boundary.
 *
 * @module @deepseek-ai/dsh-tool-executor-in-process
 */

import { ToolExecutor } from '@deepseek-ai/dsh-tool-executor'
import type { ToolExecutionOutcome, ToolExecutionRequest } from '@deepseek-ai/dsh-tool-executor'

/**
 * Runs the tool registry's inline body in-process. A local body rejection
 * propagates unchanged (so the registry's error path keeps the original error
 * object); the only failure this provider reports itself is a request with no
 * inline body, which an in-process world cannot resolve.
 */
export class InProcessToolExecutor extends ToolExecutor {
  readonly isolation = 'in-process'

  /**
   * Run an inline body, or resolve an in-process-only failure. See
   * {@link ToolExecutor.execute} for the outcome contract.
   * @param request - the body identity, arguments, signal, and (in-process) the
   *   inline body itself.
   */
  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    if (request.signal.aborted) {
      return {
        failure: {
          kind: 'abort',
          message: String(request.signal.reason ?? 'tool call aborted'),
        },
      }
    }
    const body = request.body
    if (body === undefined) {
      return {
        failure: {
          kind: 'execution-substrate',
          message: `in-process tool executor cannot resolve body "${request.toolId}" without an inline body; a cross-process world needs a container provider`,
        },
      }
    }
    // No try/catch: a local body rejection propagates unchanged so the tool
    // registry's error path sees the original error object (zero behavior change).
    return { value: await body(request.arguments, { signal: request.signal }) }
  }
}

export default InProcessToolExecutor
