/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-credentials-postgres`.
 * @module @deepseek-ai/dsh-credentials-postgres/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-credentials-postgres'

/** Cordis companion plugin name. */
export const name = 'credentials-postgres-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider owns per-tenant KV unit handles over the
 * shared postgres backend; the authoritative relation (each tenant's credential
 * map) lives in Postgres and asserting it here would require side-effectful
 * reads against a connection pool this companion does not own.
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
