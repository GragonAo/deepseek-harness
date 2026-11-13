/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mcp-external`.
 * @module @deepseek-ai/dsh-mcp-external/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-external'

/** Cordis companion plugin name. */
export const name = 'mcp-external-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the relation this package maintains — which servers a
 * live session mounted — is owned by the agent scopes it registers into, and the
 * authoritative list lives in the registry's medium. Asserting either here would
 * require owning that state, which the bridge deliberately does not.
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
