/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mcp-servers-postgres`.
 * @module @deepseek-ai/dsh-mcp-servers-postgres/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-servers-postgres'

/** Cordis companion plugin name. */
export const name = 'mcp-servers-postgres-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider owns two shared KV unit handles over the
 * postgres backend, and the authoritative relation (which rows each registry
 * holds) lives in Postgres; asserting it here would need side-effectful reads
 * against a connection pool this companion does not own.
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
