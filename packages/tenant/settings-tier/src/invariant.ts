/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-settings-tier`.
 * @module @deepseek-ai/dsh-settings-tier/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-settings-tier'

/** Cordis companion plugin name. */
export const name = 'settings-tier-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the service holds only resolved tier directories and
 * reads the authority scopes on call, with no independent event stream or
 * public mutable relation a companion could compare without entering a scope.
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
