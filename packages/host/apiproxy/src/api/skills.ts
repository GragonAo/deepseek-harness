/**
 * skills domain contract: the session-addressed skill catalog, plus the
 * caller's own skill tier — the only tier this surface writes.
 *
 * The user-global tier is resolved from the request's own tenant/user scope by
 * `dsh-skill-tier`, so no payload names a tier or a directory: a tenant request
 * cannot reach the system tier, and installing into the system tier belongs to
 * the management surface. The zip bundle is validated in full before any
 * directory changes, so a caller that gets `skill-rejected` learns every reason
 * the archive was refused instead of finding a half-written skill.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Skill catalog row (wire projection of the host SkillSummary; provider/source vocabulary stays host-side). */
export interface SkillEntry {
  /** Kebab-case identifier the user references as `/name` in the composer. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** False marks a user-only skill (`disable-model-invocation`): invocable here, absent from the model catalog. */
  readonly modelInvocable: boolean
}

/** One coded reason a tier entry never reaches the catalog. */
export interface SkillEntryIssue {
  /** Machine-readable cause, e.g. `missing-frontmatter`. */
  readonly code: string
  /** Human-readable explanation naming the offending fact. */
  readonly message: string
  /** One-based line the issue points at, when the reader could locate one. */
  readonly line?: number
}

/**
 * One entry of the caller's own tier, loadable or not. A hand-placed file that
 * never loads is still listed, with the coded reasons it is skipped, so a
 * management view can show a broken skill instead of silently omitting it.
 */
export interface SkillTierEntry {
  /** Directory or Markdown file name inside the tier directory. */
  readonly entry: string
  /** Frontmatter name this entry registers under, present only when it loads. */
  readonly name?: string
  /** Frontmatter description, present only when it loads. */
  readonly description?: string
  /** Whether the entry becomes a loadable skill. */
  readonly loadable: boolean
  /** Coded reasons an unloadable entry is skipped; empty for a loadable one. */
  readonly issues: readonly SkillEntryIssue[]
}

/** One accepted installation. */
export interface SkillInstalled {
  /** Skill name from the bundle's frontmatter, which is also its directory name. */
  readonly name: string
  /** Absolute directory now holding the skill. */
  readonly directory: string
  /** Whether an earlier skill at this directory was replaced. */
  readonly replaced: boolean
  /** Bundle-relative paths written, sorted. */
  readonly files: readonly string[]
  /** Whether the refreshed catalog lists this skill name; `false` means another provider still wins it. */
  readonly visible: boolean
}

/** One accepted removal. */
export interface SkillRemoved {
  /** Skill name the removed directory registered under. */
  readonly name: string
  /** Absolute directory that was removed. */
  readonly directory: string
  /** Whether the refreshed catalog still lists this skill name. */
  readonly visible: boolean
}

/**
 * Skill-domain unary methods (the map key skill.* of RpcMethodMap). Listing the
 * invocation catalog is addressed by session; the three tier methods address the
 * caller's own user-global tier and need no session. Invocation itself is a
 * plain `session.prompt` whose leading `/name` token the host recognizes at the
 * pre-step boundary (`dsh-tool-skill` injects the rendered body there), so every
 * client shares one deterministic path with no dedicated invocation wire.
 */
export interface SkillsApi {
  /** Lists the user-invocable skill catalog for the session's project. */
  list(request: RpcRequest<{ sessionId: SessionId }>): Promise<RpcResponse<{ skills: readonly SkillEntry[] }>>

  /**
   * Installs one zip skill bundle into the caller's user-global tier and
   * refreshes every cached catalog, so the skill is invocable by the next read.
   * The archive must hold exactly one skill document at its root, optionally
   * wrapped in one directory; a wrapping directory, an entry escaping the skill
   * directory, an oversized bundle, or an unloadable document refuses the whole
   * installation before the tier changes. An existing skill of the same name is
   * refused unless `replace` is set.
   */
  install(request: RpcRequest<{ zip: string; replace?: boolean }>): Promise<RpcResponse<SkillInstalled>>

  /** Removes one skill from the caller's user-global tier by frontmatter or directory name. */
  remove(request: RpcRequest<{ name: string }>): Promise<RpcResponse<SkillRemoved>>

  /** Lists the caller's user-global tier, including entries that never load and why. */
  installed(request: RpcRequest<{}>): Promise<RpcResponse<{ directory: string; entries: readonly SkillTierEntry[] }>>
}
