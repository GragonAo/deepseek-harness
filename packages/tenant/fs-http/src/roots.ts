/**
 * Path resolution for the multi-tenant file surface: the five scopes a
 * subject's work lives in, and the confinement that keeps a requested path
 * inside the one root its scope names.
 *
 * The scopes are the same tree the sandbox mounts, so a business client and the
 * model address one file by one path:
 *
 * | scope | host directory | sandbox | writable |
 * |---|---|---|---|
 * | `session` | `<workspaceRoot>/users/<subject>/sessions` | `/sessions` | yes |
 * | `user` | `<workspaceRoot>/users/<subject>/work` | `/workspace` | yes |
 * | `case` | `<workspaceRoot>/work` | `/case` | no |
 * | `global` | `<usersRoot>/<subject>/work` | `/global` | no |
 * | `system` | `<systemRoot>` | `<systemRoot>`, same path | no |
 *
 * A `session` request names its session directory in the first path segment
 * (`session/<sessionId>/notes.md`), which is why that scope's root is the whole
 * sessions directory rather than one session.
 *
 * @module @deepseek-ai/dsh-tenant-fs-http/roots
 */

import { realpath, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { TENANT_SESSIONS_DIR_NAME, TENANT_USERS_DIR_NAME, TENANT_WORK_DIR_NAME } from '@deepseek-ai/dsh-tenant'
import type { Tenant, UserId } from '@deepseek-ai/dsh-tenant'

/** Every scope a file path may name. */
export const FILE_SCOPES = ['session', 'user', 'case', 'global', 'system'] as const

/** One scope name. */
export type FileScope = (typeof FILE_SCOPES)[number]

/**
 * Scopes that accept a write. The other three are the read side of a deployment:
 * the case and global work directories are written by the business layer, and the
 * system tree by the operator, so a browser acting for one subject must not
 * change them.
 */
const WRITABLE_SCOPES: ReadonlySet<FileScope> = new Set<FileScope>(['session', 'user'])

/** Inputs the scope table is derived from. */
export interface ScopeRootsInput {
  /** The tenant the request acts for. */
  tenant: Tenant
  /** The subject, already resolved as a member of `tenant`. */
  subject: UserId
  /** Deployment root of the cross-case work directories; `global` is absent without it. */
  usersRoot?: string | undefined
  /** Deployment root of the system tree; `system` is absent without it. */
  systemRoot?: string | undefined
}

/** One scope's host root. */
export interface ScopeRoot {
  /** Which scope this root serves. */
  scope: FileScope
  /** Absolute host directory the scope's paths resolve inside. */
  dir: string
  /** Whether a write into this scope is accepted. */
  writable: boolean
}

/**
 * Derive the scope table for one request's (tenant, subject).
 * @param input - the tenant record, the subject, and the deployment roots.
 * @returns every scope this deployment can serve, keyed by scope name. A scope
 * absent from the map is one this deployment does not configure (no `usersRoot`
 * or no `systemRoot`); the surface answers that as unavailable rather than as an
 * empty directory.
 */
export function scopeRoots(input: ScopeRootsInput): ReadonlyMap<FileScope, ScopeRoot> {
  const { tenant, subject, usersRoot, systemRoot } = input
  const caseUser = join(tenant.workspaceRoot, TENANT_USERS_DIR_NAME, String(subject))
  const roots: ScopeRoot[] = [
    { scope: 'session', dir: join(caseUser, TENANT_SESSIONS_DIR_NAME), writable: WRITABLE_SCOPES.has('session') },
    { scope: 'user', dir: join(caseUser, TENANT_WORK_DIR_NAME), writable: WRITABLE_SCOPES.has('user') },
    { scope: 'case', dir: join(tenant.workspaceRoot, TENANT_WORK_DIR_NAME), writable: WRITABLE_SCOPES.has('case') },
  ]
  if (usersRoot !== undefined) {
    roots.push({ scope: 'global', dir: join(usersRoot, String(subject), TENANT_WORK_DIR_NAME), writable: WRITABLE_SCOPES.has('global') })
  }
  if (systemRoot !== undefined) roots.push({ scope: 'system', dir: systemRoot, writable: WRITABLE_SCOPES.has('system') })
  return new Map(roots.map(root => [root.scope, root]))
}

/** Why a requested path cannot be served. */
export type TargetFailureCode =
  | 'file-scope-unknown'
  | 'file-scope-unavailable'
  | 'file-path-invalid'
  | 'file-root-missing'

/** A resolved on-disk target, or the reason there is none. */
export type Target =
  | { ok: true; root: ScopeRoot; hostPath: string; relative: string }
  | { ok: false; code: TargetFailureCode; message: string }

/**
 * Resolve one `(scope, segments)` request to a host path inside that scope's root.
 *
 * Every segment must be a plain name. `.`, `..`, an empty name, or a segment
 * containing a path separator or a NUL would move the target out of its root, so
 * each is refused before any filesystem call. Confinement is then checked against
 * the filesystem rather than the string: the root and the nearest existing
 * ancestor of the target are resolved through `realpath`, so a symlink planted
 * inside a write scope cannot redirect a read or a write outside it.
 * @param roots - the scope table for this request.
 * @param scope - the requested scope name, verbatim from the URL.
 * @param segments - the decoded path below the scope, or `undefined` when a
 * segment could not be decoded at all.
 * @returns the host path and its scope root, or a failure code the surface maps to a status.
 */
export async function resolveTarget(
  roots: ReadonlyMap<FileScope, ScopeRoot>,
  scope: string,
  segments: readonly string[] | undefined,
): Promise<Target> {
  if (!isFileScope(scope)) {
    return { ok: false, code: 'file-scope-unknown', message: `不认识的作用域 "${scope}"：可用的是 ${FILE_SCOPES.join('、')}` }
  }
  const root = roots.get(scope)
  if (root === undefined) {
    const missing = scope === 'global' ? '缺少 usersRoot' : scope === 'system' ? '缺少 systemRoot' : '检查租户记录的 workspaceRoot'
    return { ok: false, code: 'file-scope-unavailable', message: `这个部署没有配置 ${scope} 作用域的宿主目录：${missing}` }
  }
  const valid = segments === undefined ? undefined : plainSegments(segments)
  if (valid === undefined) {
    return {
      ok: false,
      code: 'file-path-invalid',
      message: '路径段非法：不接受空段、"."、".."、路径分隔符或百分号编码的斜杠',
    }
  }
  const confined = await confine(root.dir, valid)
  if (!confined.ok) {
    if (confined.reason === 'root-missing') {
      return { ok: false, code: 'file-root-missing', message: `${scope} 作用域的宿主目录不存在或不是目录：${root.dir}` }
    }
    return { ok: false, code: 'file-path-invalid', message: `路径越出 ${scope} 作用域：${valid.join('/')}` }
  }
  return { ok: true, root, hostPath: confined.hostPath, relative: valid.join('/') }
}

/** Whether one URL segment names a scope. */
function isFileScope(value: string): value is FileScope {
  return (FILE_SCOPES as readonly string[]).includes(value)
}

/**
 * Decode one raw URL path segment list and validate each name.
 * @param raw - path segments exactly as they arrive in the URL, still percent-encoded.
 * @returns the decoded names, or `undefined` when a segment is malformed or unsafe.
 */
export function decodeSegments(raw: readonly string[]): string[] | undefined {
  const decoded: string[] = []
  for (const part of raw) {
    if (part.length === 0) continue
    let segment: string
    try {
      segment = decodeURIComponent(part)
    } catch {
      // A malformed escape has no partial reading: the client re-encodes or asks again.
      return undefined
    }
    if (!isPlainName(segment)) return undefined
    decoded.push(segment)
  }
  return decoded
}

/**
 * Validate segments that arrive already decoded (a query-string path).
 * @param parts - the names below the scope.
 * @returns the names, or `undefined` when one of them is unsafe.
 */
export function plainSegments(parts: readonly string[]): string[] | undefined {
  const names: string[] = []
  for (const part of parts) {
    if (part.length === 0) continue
    if (!isPlainName(part)) return undefined
    names.push(part)
  }
  return names
}

/**
 * Whether one decoded segment is a plain name.
 * @param segment - one path segment.
 * @returns whether the segment names one entry inside its directory.
 */
function isPlainName(segment: string): boolean {
  if (segment === '.' || segment === '..') return false
  return !segment.includes('/') && !segment.includes('\\') && !segment.includes('\0')
}

/**
 * Join the segments under `rootDir` and prove the result cannot leave it.
 * @param rootDir - the scope's host root.
 * @param segments - validated segments from the request.
 * @returns the host path, or why there is none: the root is not a directory, or
 * a symlink resolves outside it.
 */
async function confine(
  rootDir: string,
  segments: readonly string[],
): Promise<{ ok: true; hostPath: string } | { ok: false; reason: 'root-missing' | 'escape' }> {
  let root: string
  try {
    const info = await stat(rootDir)
    if (!info.isDirectory()) return { ok: false, reason: 'root-missing' }
    root = await realpath(rootDir)
  } catch {
    // Only ENOENT reaches here for a configured root: a permission error on the
    // deployment's own root is not a per-request condition, and the operation
    // that follows reports it together with the path it was given.
    return { ok: false, reason: 'root-missing' }
  }
  const hostPath = join(root, ...segments)
  if (!inside(root, hostPath)) return { ok: false, reason: 'escape' }
  const existing = await realpathOfNearest(hostPath)
  if (existing !== undefined && !inside(root, existing)) return { ok: false, reason: 'escape' }
  return { ok: true, hostPath }
}

/**
 * Resolve the closest existing path at or above `hostPath`.
 * @param hostPath - the target, which may not exist yet.
 * @returns its real path, or `undefined` when it cannot be resolved — a missing
 * chain above the root, or a non-directory in the middle, both of which the
 * operation that needed the path reports itself.
 */
async function realpathOfNearest(hostPath: string): Promise<string | undefined> {
  let current = hostPath
  for (;;) {
    try {
      return await realpath(current)
    } catch (error: unknown) {
      // ENOENT means the target (or its parent) does not exist yet: walk up to the
      // nearest existing ancestor and confine that instead.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Whether `target` is `base` or lies below it.
 *
 * Windows compares case-insensitively because the filesystem does: a path that
 * differs only in case names the same file, so a case-sensitive prefix test would
 * miss the alias.
 * @param base - the confinement root.
 * @param target - the path to test.
 * @returns whether the target stays inside the root.
 */
function inside(base: string, target: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const confined = normalize(base)
  const candidate = normalize(target)
  if (candidate === confined) return true
  return candidate.startsWith(confined.endsWith(sep) ? confined : `${confined}${sep}`)
}
