/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-code-runtime-container`.
 * @module @deepseek-ai/dsh-code-runtime-container/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-code-runtime-container'

/** Cordis companion plugin name. */
export const name = 'code-runtime-container-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package exposes no durable event sequence or
 * mutable data relation of its own; it only transports run-code programs into
 * the tenant container and bridges their declared bindings over a loopback
 * HTTP surface. `code-runtime-container` owns the run lifecycle through the
 * `ctx.containerRuntime` service, whose invariant companion covers the
 * tenant-scoped container world.
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
