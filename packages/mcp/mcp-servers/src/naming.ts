/**
 * Mount-name derivation. A server's `serverName` is what the client namespaces
 * tools under (`mcp__<name>__<tool>`), so it is bound by the client's own rule:
 * `[A-Za-z0-9_-]{1,32}`. A `system` row keeps its name verbatim, so tools of
 * servers registered before this registry existed keep the names sessions
 * already know. A `user` row is prefixed with a short digest of its owner, which
 * keeps two users' identically named servers apart without leaking a user id
 * into the model-visible tool name.
 * @module @deepseek-ai/dsh-mcp-servers/naming
 */

import { createHash } from 'node:crypto'

/** The client's namespace rule for one server name. */
export const MOUNT_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Longest mount name the client accepts. */
export const MOUNT_NAME_MAX = 32

/**
 * The prefix a user's rows mount under: a digest, not the raw user id, because a
 * tenant user id is commonly longer than the whole namespace allows.
 * @param userId - owning user.
 * @returns the prefix including its trailing separator.
 */
export function userMountPrefix(userId: string): string {
  const digest = createHash('sha256').update(userId).digest('hex').slice(0, 8)
  return `u_${digest}__`
}

/**
 * The longest `serverName` a row of this origin may carry.
 * @param origin - registry the row belongs to.
 * @param userId - owning user, required for a `user` row.
 * @returns the remaining character budget for the stored name.
 */
export function serverNameBudget(origin: 'system' | 'user', userId?: string): number {
  if (origin === 'system') return MOUNT_NAME_MAX
  if (userId === undefined) throw new TypeError('mcp-servers: a user row needs an owner to compute its name budget')
  return MOUNT_NAME_MAX - userMountPrefix(userId).length
}

/**
 * The name a stored row is mounted under.
 * @param origin - registry the row belongs to.
 * @param serverName - stored name.
 * @param userId - owning user, required for a `user` row.
 * @returns the mount name, which is also the tool-name namespace.
 */
export function mountNameFor(origin: 'system' | 'user', serverName: string, userId?: string): string {
  if (origin === 'system') return serverName
  if (userId === undefined) throw new TypeError('mcp-servers: a user row needs an owner to compute its mount name')
  return `${userMountPrefix(userId)}${serverName}`
}
