/**
 * Package-owned invariant companion for @deepseek-ai/dsh-container-k8s.
 * @module @deepseek-ai/dsh-container-k8s/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-container-k8s'

/** Cordis companion plugin name. */
export const name = 'container-k8s-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the relation worth checking is that a live sandbox
 * Pod's dsh.dev/spec-fingerprint annotation equals the digest this process
 * would compute for the same (tenant, user). Reading it needs a cluster round
 * trip, which an installer cannot take without acting on the deployment it is
 * checking. The provider asserts that equality on every call instead, in
 * ensureSandbox, where it already holds both values.
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
