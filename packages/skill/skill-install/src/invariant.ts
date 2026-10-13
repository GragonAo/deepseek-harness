/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-skill-install`.
 * @module @deepseek-ai/dsh-skill-install/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-skill-install'

/** Cordis companion plugin name. */
export const name = 'skill-install-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no event stream and no in-memory
 * mutable relation. Its one durable effect is the tier directory, and every
 * operation re-reads the refreshed catalog before reporting that effect, so the
 * acceptance each call needs is the call's own result rather than an ongoing
 * stream relationship.
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
