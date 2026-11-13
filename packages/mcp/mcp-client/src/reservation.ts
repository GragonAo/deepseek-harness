/**
 * `serverName` reservation: the client namespaces every tool of one server under
 * `mcp__<serverName>__<rawName>`, so two live instances must not claim the same
 * namespace where they would be visible together.
 *
 * Uniqueness is per scope, not per process. A registration made through a scope
 * (a per-user server mounted for one agent) legitimately shadows a
 * context-global instance of the same name: the tool registry resolves a name
 * through the scope chain, nearest scope first, so the outer instance keeps
 * serving the sessions it was mounted for. Two instances in the SAME scope
 * remain a configuration error raised at plugin load — never silent shadowing.
 * @module @deepseek-ai/dsh-mcp-client/reservation
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'

/**
 * Live reservations, keyed by the registration's scope. A context-global
 * registration is keyed by its app root, so several apps in one process (tests)
 * never see each other's names.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

/**
 * Claim `serverName` for the scope of `ctx`.
 * @param ctx - the context the client instance is mounted on.
 * @param serverName - the namespace to claim.
 * @returns the release for that claim.
 * @throws when the same scope already holds the name.
 */
export function reserveServerName(ctx: Context, serverName: string): () => void {
  const owner: object = scopeOf(ctx) ?? ctx.root
  let names = activeServerNames.get(owner)
  if (names === undefined) {
    names = new Set()
    activeServerNames.set(owner, names)
  }
  if (names.has(serverName)) {
    throw new Error(
      `mcp-client: serverName "${serverName}" is already in use by another mcp-client instance in the same scope — pick a unique serverName in cordis.yml`,
    )
  }
  names.add(serverName)
  return () => void names.delete(serverName)
}
