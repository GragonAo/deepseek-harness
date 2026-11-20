/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-uploads`.
 * @module @deepseek-ai/dsh-session-uploads/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-uploads'

/** Cordis companion plugin name. */
export const name = 'session-uploads-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the listing is an advisory read of a directory the
 * deployment owns, and every assembly that contributes it is observable through
 * `systemPrompt.assemble` and asserted by the package tests.
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
