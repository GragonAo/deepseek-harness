/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tenant-admin-http`.
 * @module @deepseek-ai/dsh-tenant-admin-http/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tenant-admin-http'

/** Cordis companion plugin name. */
export const name = 'tenant-admin-http-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the carrier owns a routed request surface over
 * `ctx.tenantAdmin` and keeps no durable, evented, or authoritative state of
 * its own — every fact it serves is read from the registry or the record store
 * at call time.
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
