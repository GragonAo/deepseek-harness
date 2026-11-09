/** Package-owned durable follow-up-suggestion invariants. @module @deepseek-ai/dsh-session-followups/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-followups'

/** Validate one non-negative integer turn number. */
function assertTurn(value: unknown, event: string, fail: InvariantFailure): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${event} turn must be a non-negative integer`)
  }
}

/**
 * Validate the accepted suggestion batch before it reaches the durable log.
 *
 * Trimmed-and-unique is a durable shape rule, not a UI preference: every consumer
 * renders the recorded question verbatim, so a padded or repeated question would
 * render twice or with stray whitespace.
 */
function validateSuggested(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null) fail('followup/suggested must carry an object payload')
  const { turn, questions } = value as Record<string, unknown>
  assertTurn(turn, 'followup/suggested', fail)
  if (!Array.isArray(questions) || questions.length === 0) {
    fail('followup/suggested must carry at least one question')
  }
  const seen = new Set<string>()
  for (const question of questions) {
    if (typeof question !== 'string' || question.length === 0 || question.trim() !== question) {
      fail('followup/suggested questions must be non-empty and already trimmed')
    }
    if (seen.has(question)) fail(`followup/suggested repeats question ${JSON.stringify(question)}`)
    seen.add(question)
  }
}

/** Validate the logged auxiliary request that produced one batch. */
function validateRequest(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null) fail('followup/llm-request must carry an object payload')
  const { turn, route, system, messages, maxTokens } = value as Record<string, unknown>
  assertTurn(turn, 'followup/llm-request', fail)
  if (typeof route !== 'object' || route === null) fail('followup/llm-request must record a route object')
  const { provider, model } = route as Record<string, unknown>
  if (typeof provider !== 'string' || provider.length === 0) {
    fail('followup/llm-request route.provider must be a non-empty string')
  }
  if (typeof model !== 'string' || model.length === 0) {
    fail('followup/llm-request route.model must be a non-empty string')
  }
  if (typeof system !== 'string' || system.trim().length === 0) {
    fail('followup/llm-request system must be a non-empty string')
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    fail('followup/llm-request must record at least one message')
  }
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    fail('followup/llm-request maxTokens must be a positive integer')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'followup/suggested') validateSuggested(event.data, fail)
  if (event.type === 'followup/llm-request') validateRequest(event.data, fail)
}

/** Install validation for loaded and newly appended follow-up events. */
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
 * Register the follow-up-suggestion invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

/** Cordis companion plugin name. */
export const name = 'session-followups-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']
