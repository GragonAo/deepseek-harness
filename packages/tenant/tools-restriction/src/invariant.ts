/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tools-restriction`.
 * @module @deepseek-ai/dsh-tools-restriction/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tools-restriction'

/** Cordis companion plugin name. */
export const name = 'tools-restriction-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin reads tier documents and files the resulting
 * restrictions into each agent's own scope through the tool registry, and owns
 * no state of its own — the registry's visible map and the filesystem are the
 * authoritative sources, and their relation is asserted by the registry and by
 * the tier provider rather than restated here.
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
