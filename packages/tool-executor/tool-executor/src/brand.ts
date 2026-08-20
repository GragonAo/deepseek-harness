/**
 * dsh-tool-executor's owned branded id: execution-body identity.
 *
 * The `Branded<B>` primitive itself lives in `@deepseek-ai/dsh-brand` (a
 * zero-dependency type-only package) so every owner of a cross-boundary id
 * brands it without depending on an unrelated capability package.
 *
 * @module @deepseek-ai/dsh-tool-executor/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identity of one execution body. The agent plane mints it at tool
 * registration; an execution-world provider locates the body it names. Branded
 * so it cannot be confused with a tool name, a call id, or another seam's id.
 */
export type ToolBodyId = Branded<'ToolBodyId'>

/**
 * Brand a string as a {@link ToolBodyId}.
 * @param id - the opaque body identity minted at registration.
 * @returns the same string, branded; no validation is performed.
 */
export function ToolBodyId(id: string): ToolBodyId {
  return id as ToolBodyId
}
