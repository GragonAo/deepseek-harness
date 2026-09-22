/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tenant-admin-postgres`.
 * @module @deepseek-ai/dsh-tenant-admin-postgres/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tenant-admin-postgres'

/** Cordis companion plugin name. */
export const name = 'tenant-admin-postgres-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider owns a live connection pool, the shared
 * `tenant_record` table, and per-tenant schema state; the management service
 * is the only consumer of its registered seams, and no independent event stream
 * or public mutable relation exists to compare without re-deriving every
 * database write as a side effect.
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
