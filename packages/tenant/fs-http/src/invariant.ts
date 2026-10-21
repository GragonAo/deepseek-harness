/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tenant-fs-http`.
 * @module @deepseek-ai/dsh-tenant-fs-http/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tenant-fs-http'

/** Cordis companion plugin name. */
export const name = 'tenant-fs-http-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the surface owns no state of its own — the filesystem it
 * serves is the record, and every answer is derived from one `realpath`-confined
 * resolution of the request's own scope root, so there is no second relation
 * inside the process to compare the served bytes against.
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
