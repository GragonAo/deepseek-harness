/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-http`.
 * @module @deepseek-ai/dsh-agent-http/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-http'

/** Cordis companion plugin name. */
export const name = 'agent-http-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the carrier is a stateless Request -> Response
 * function with no event stream, registry, or public mutable relation of its
 * own to compare against — the tenant authorities and the gateway it delegates
 * to are owned by their respective packages.
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
