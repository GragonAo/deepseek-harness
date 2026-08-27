/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tools-manifest`.
 * @module @deepseek-ai/dsh-tools-manifest/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tools-manifest'

/** Cordis companion plugin name. */
export const name = 'tools-manifest-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the loader registers tools into each agent's own scope
 * and owns no independent event stream or public mutable relation; the tool
 * registry's `tools/change` stream already reports every registration it makes,
 * so a companion here would only re-check a relation the registry asserts.
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
