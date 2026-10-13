/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-partition-scope`.
 * @module @deepseek-ai/dsh-partition-scope/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-partition-scope'

/** Cordis companion plugin name. */
export const name = 'partition-scope-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns only the seam's types, one reader over the optional
 * service store, and a predicate over an error code; it registers no event stream and holds no
 * mutable data of its own.
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
