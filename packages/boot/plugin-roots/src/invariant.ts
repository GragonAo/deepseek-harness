/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-plugin-roots`.
 * @module @deepseek-ai/dsh-plugin-roots/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugin-roots'

/** Cordis companion plugin name. */
export const name = 'plugin-roots-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package publishes one immutable resolver built from
 * its own validated configuration and owns no mutable data, event stream, or
 * registry a check could relate. A root that disappears after mount surfaces as
 * a module-resolution failure at the next reload, not as silent state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
