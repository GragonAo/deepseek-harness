/** Package-owned durable deliverable-declaration invariants. @module @deepseek-ai/dsh-tool-present/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-present'

/**
 * Validate one declaration before it reaches the durable log: the turn it attributes to, the call
 * that made it, and a non-empty list of unique, already-trimmed paths.
 *
 * Trimmed-and-unique is a durable-shape rule, not a UI preference: every consumer renders the
 * recorded path verbatim and dedupes by it, so a padded or repeated path would render twice.
 */
function validatePresented(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null) fail('deliverables/presented must carry an object payload')
  const { turn, callId, files } = value as Record<string, unknown>
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) {
    fail('deliverables/presented turn must be a non-negative integer')
  }
  if (typeof callId !== 'string' || callId.length === 0) {
    fail('deliverables/presented callId must be a non-empty string')
  }
  if (!Array.isArray(files) || files.length === 0) {
    fail('deliverables/presented must declare at least one file')
  }
  const seen = new Set<string>()
  for (const file of files) {
    if (typeof file !== 'object' || file === null) fail('deliverables/presented entries must be objects')
    const { path, description } = file as Record<string, unknown>
    if (typeof path !== 'string' || path.length === 0 || path.trim() !== path) {
      fail('deliverables/presented path must be non-empty and already trimmed')
    }
    if (seen.has(path)) fail(`deliverables/presented repeats path ${JSON.stringify(path)}`)
    seen.add(path)
    if (description === undefined) continue
    if (typeof description !== 'string' || description.length === 0 || description.trim() !== description) {
      fail('deliverables/presented description must be a non-empty trimmed string when present')
    }
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'deliverables/presented') validatePresented(event.data, fail)
}

/** Install validation for loaded and newly appended declarations. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the deliverable-declaration invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

/** Cordis companion plugin name. */
export const name = 'tool-present-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
