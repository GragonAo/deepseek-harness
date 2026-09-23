/**
 * Path, naming, and delivery-tag rules shared by the artifact tools: where a case's published
 * files land under the deployment's static directory, which sandbox paths a call may read from, and
 * what the model is told to write into its reply.
 * @module @deepseek-ai/dsh-tool-artifact/artifact-store
 */

import { posix, resolve as resolveHost, sep } from 'node:path'

/** One sandbox mount, as the model addresses it and as the host stores it. */
export interface Mount {
  /** Absolute POSIX path inside the sandbox (e.g. `/workspace`). */
  readonly container: string
  /** Absolute host directory that mount resolves to. */
  readonly host: string
}

/** Static-file directory a published artifact is filed under. */
export type ArtifactKind = 'html' | 'docs' | 'sheets' | 'slides' | 'images' | 'data' | 'packages' | 'other'

/** Every {@link ArtifactKind}, in the order the tool schema offers them. */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['html', 'docs', 'sheets', 'slides', 'images', 'data', 'packages', 'other']

/**
 * Opening marker of the delivery tag the deployment's web front end parses out of a reply. Fixed
 * protocol: the front end matches the exact literals of this marker pair, so neither is deployment
 * configuration.
 */
export const TAG_OPEN = '[hermes-attachment]'

/** Closing marker of the delivery tag opened by {@link TAG_OPEN}. */
export const TAG_CLOSE = '[/hermes-attachment]'

/** Extension (leading dot, lowercase) to delivery directory. Unlisted extensions land in `other`. */
const KIND_BY_EXTENSION: Readonly<Record<string, ArtifactKind>> = {
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docs',
  '.doc': 'docs',
  '.pdf': 'docs',
  '.rtf': 'docs',
  '.odt': 'docs',
  '.xlsx': 'sheets',
  '.xls': 'sheets',
  '.csv': 'sheets',
  '.ods': 'sheets',
  '.pptx': 'slides',
  '.ppt': 'slides',
  '.odp': 'slides',
  '.png': 'images',
  '.jpg': 'images',
  '.jpeg': 'images',
  '.gif': 'images',
  '.webp': 'images',
  '.svg': 'images',
  '.bmp': 'images',
  '.ico': 'images',
  '.json': 'data',
  '.xml': 'data',
  '.txt': 'data',
  '.md': 'data',
  '.log': 'data',
  '.zip': 'packages',
  '.tar': 'packages',
  '.gz': 'packages',
  '.7z': 'packages',
}

/**
 * Delivery directory for one file extension.
 * @param extension - the extension including its leading dot, or an empty string.
 * @returns the delivery directory, `other` when the extension is not mapped.
 */
export function kindForExtension(extension: string): ArtifactKind {
  return KIND_BY_EXTENSION[extension.toLowerCase()] ?? 'other'
}

/**
 * Split a file name into the stem and extension a delivery name is built from.
 * @param fileName - the source file name, without directories.
 * @returns the stem and the lowercase extension including its leading dot (empty when absent).
 */
export function splitExtension(fileName: string): { stem: string; ext: string } {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return { stem: fileName, ext: '' }
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot).toLowerCase() }
}

/**
 * Reduce one path or name segment to a portable, URL-safe token: letters, digits, `.`, `_`, `-`
 * survive, everything else (separators, control characters, URL-significant punctuation, spaces)
 * becomes `_`. Leading and trailing punctuation is dropped so a segment can never be `..`, empty,
 * or a hidden file, and the result is bounded so a long title cannot exhaust the file-name limit.
 * @param value - the raw segment.
 * @param fallback - the segment to use when nothing survives sanitization.
 * @returns the sanitized segment.
 */
export function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : fallback
}

/**
 * Format a timestamp for a delivery file name, in the host's local time.
 * @param date - the moment the artifact is published.
 * @returns `YYYYmmdd_HHMMSS`.
 */
export function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Address a model-supplied path against the sandbox mounts.
 * @param input - the model-supplied path, absolute or relative to `cwd`.
 * @param cwd - the calling session's working directory, used for relative paths.
 * @param mounts - the mounts this call may read from.
 * @returns the owning mount and the path relative to it, or `null` when no mount owns the path.
 */
export function addressContainerPath(
  input: string,
  cwd: string,
  mounts: readonly Mount[],
): { mount: Mount; containerPath: string; relativePath: string } | null {
  const absolute = posix.isAbsolute(input) ? posix.normalize(input) : posix.resolve(cwd, input)
  for (const mount of mounts) {
    const root = posix.normalize(mount.container)
    if (absolute !== root && !absolute.startsWith(`${root}/`)) continue
    return { mount, containerPath: absolute, relativePath: absolute === root ? '' : absolute.slice(root.length + 1) }
  }
  return null
}

/**
 * Whether a host path is the root itself or lies below it.
 * @param root - the directory the path must stay inside.
 * @param candidate - the path to test.
 * @returns true when `candidate` is inside `root`.
 */
export function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolveHost(root)
  const normalized = resolveHost(candidate)
  if (normalized === normalizedRoot) return true
  return normalized.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`)
}

/**
 * The same-origin path the web front end serves one published file from. Segments are already
 * sanitized by {@link sanitizeSegment}, so they need no URL escaping.
 * @param urlPrefix - the front end's static route prefix (e.g. `/media`).
 * @param segments - the path segments below the prefix.
 * @returns the absolute same-origin path.
 */
export function publicPathFor(urlPrefix: string, segments: readonly string[]): string {
  return [urlPrefix.replace(/\/+$/, ''), ...segments].join('/')
}

/**
 * The delivery tag carrying a published file's same-origin path. The tag holds a path, never a
 * scheme, host, or port: a reply is frozen when it is sent, so an absolute origin would pin the
 * deployment topology into history.
 * @param publicPath - the path returned by {@link publicPathFor}.
 * @returns the tag the model appends to its reply.
 */
export function attachmentTag(publicPath: string): string {
  return `${TAG_OPEN} ${publicPath} ${TAG_CLOSE}`
}

/**
 * The delivery file name for one attempt: the timestamped stem, with `_2`, `_3` … appended when an
 * earlier attempt lost a race for the same name.
 * @param stamp - the publish timestamp from {@link formatStamp}.
 * @param stem - the sanitized file stem.
 * @param extension - the extension including its leading dot, or an empty string.
 * @param attempt - the 1-based attempt number.
 * @returns the file name to try.
 */
export function deliveryName(stamp: string, stem: string, extension: string, attempt: number): string {
  return `${stamp}_${stem}${attempt === 1 ? '' : `_${attempt}`}${extension}`
}
