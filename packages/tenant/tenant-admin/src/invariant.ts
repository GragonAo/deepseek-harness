/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tenant-admin`.
 * @module @deepseek-ai/dsh-tenant-admin/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tenant-admin'

/** Cordis companion plugin name. */
export const name = 'tenant-admin-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the management surface writes the tenant registry and
 * its optional stores directly, and no independent event stream reports those
 * mutations for a companion to compare without re-deriving every create/remove
 * transition as a side effect.
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
