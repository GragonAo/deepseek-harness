/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-storage-postgres`.
 * @module @deepseek-ai/dsh-storage-postgres/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-storage-postgres'

/** Cordis companion plugin name. */
export const name = 'storage-postgres-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the backend owns a live connection pool, the
 * open-unit table, and per-tenant schema state; there is no authoritative
 * event stream or public mutable relation it could assert without side
 * effects.
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
