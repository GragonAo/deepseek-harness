/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workflow-container`.
 * @module @deepseek-ai/dsh-workflow-container/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workflow-container'

/** Cordis companion plugin name. */
export const name = 'workflow-container-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package exposes no durable event sequence or
 * mutable data relation of its own; it only transports workflow scripts into
 * the tenant container and bridges their `agent()` calls over a loopback HTTP
 * surface. The run lifecycle it owns resolves through the `ctx.workflowEngine`
 * service, whose `workflow/*` event stream the engine's own invariant
 * companion (from the workflow seam) covers.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
