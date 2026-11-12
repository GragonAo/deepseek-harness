/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-skill-publish`.
 * @module @deepseek-ai/dsh-tool-skill-publish/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-skill-publish'

/** Cordis companion plugin name. */
export const name = 'tool-skill-publish-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no event stream, no durable state, and
 * no in-memory mutable relation. It reads one directory and posts it to the
 * management plane, which answers with the record it filed; that answer is the
 * acceptance each call needs, so there is no ongoing stream relationship to
 * observe.
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
