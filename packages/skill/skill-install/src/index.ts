/**
 * Skill bundle installation into an ambient skill tier.
 *
 * A skill bundle is a zip archive holding exactly one skill document at its
 * root, optionally wrapped in one directory the way a `git archive` or a
 * hosting service hands it out. This package validates that document with the
 * seam-owned format reader, swaps the extracted directory into the tier
 * directory as one rename, and refreshes every cached catalog through
 * `ctx.skills.refresh()`, so an installed skill is discoverable by the next
 * read instead of only after a watcher event that a hand-placed file never
 * produces.
 *
 * The writable directory is never configured here: requests name a
 * {@link SkillTierKind} and the ambient `ctx.skillTiers` roots resolve it, so a
 * platform-scoped caller can only reach the system tier while a tenant-scoped
 * caller reaches its own case and user-global tiers with the same call.
 *
 * @module @deepseek-ai/dsh-skill-install
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import {
  isSkillName,
  readSkillDocument,
  type SkillDocument,
  type SkillDocumentIssue,
  type SkillTierKind,
} from '@deepseek-ai/dsh-skill'

/** Cordis plugin name. */
export const name = 'skill-install'

/** Service required before a bundle can be installed: the catalog a mutation refreshes. */
export const inject = ['skills']

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillInstall: SkillInstallService
  }
}

const DEFAULT_MAX_BUNDLE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const MAX_BUNDLE_ENTRIES = 2048
const SKILL_ENTRY = 'SKILL.md'
const STAGING_PREFIX = '.install-'
const REPLACED_PREFIX = '.replaced-'

/** Skill bundle installation configuration. */
export interface Config {
  /** Largest accepted compressed bundle in bytes. Defaults to 16 MiB. */
  maxBundleBytes?: number
  /** Largest accepted total expanded size in bytes. Defaults to 64 MiB. */
  maxExpandedBytes?: number
}

/** Validate the installation bounds. */
export const Config: Schema<Config> = z.object({
  maxBundleBytes: z.number(),
  maxExpandedBytes: z.number(),
})

interface ResolvedConfig {
  maxBundleBytes: number
  maxExpandedBytes: number
}

/** Why an installation request was refused. */
export type SkillInstallErrorCode =
  | 'tier-unavailable'
  | 'bundle-invalid'
  | 'bundle-unsafe-entry'
  | 'bundle-too-large'
  | 'skill-invalid'
  | 'skill-exists'
  | 'skill-absent'
  | 'skill-ambiguous'

/** Refusal of one installation or removal request, carrying its own reason. */
export class SkillInstallError extends Error {
  /**
   * @param code - machine-readable cause a caller reports or switches on.
   * @param message - human-readable explanation naming the offending fact.
   * @param details - optional structured evidence, such as the coded document issues.
   */
  constructor(
    readonly code: SkillInstallErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'SkillInstallError'
  }
}

/** One uploaded skill bundle, addressed to an ambient tier. */
export interface SkillInstallRequest {
  /** Ambient tier receiving the bundle; a tier absent from the current scope is refused. */
  readonly tier: SkillTierKind
  /** The zip archive bytes. */
  readonly bundle: Uint8Array
  /** Whether an existing skill of the same name may be replaced. Defaults to refusing. */
  readonly replace?: boolean
  /** Cancels the installation before or during the swap. */
  readonly signal?: AbortSignal | undefined
}

/** Result of one accepted installation. */
export interface SkillInstallResult {
  /** Tier the skill was installed into. */
  readonly tier: SkillTierKind
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

/** One skill removal request. */
export interface SkillRemoveRequest {
  /** Ambient tier holding the skill; a tier absent from the current scope is refused. */
  readonly tier: SkillTierKind
  /** Skill name, or the directory name holding it. */
  readonly name: string
  /** Cancels the removal before the directory is deleted. */
  readonly signal?: AbortSignal | undefined
}

/** Result of one accepted removal. */
export interface SkillRemoveResult {
  /** Tier the skill was removed from. */
  readonly tier: SkillTierKind
  /** Skill name the removed directory registered under. */
  readonly name: string
  /** Absolute directory that was removed. */
  readonly directory: string
  /** Whether the refreshed catalog still lists this skill name. */
  readonly visible: boolean
}

/** One tier listing request. */
export interface SkillListRequest {
  /** Ambient tier to inspect; a tier absent from the current scope is refused. */
  readonly tier: SkillTierKind
  /** Cancels the listing. */
  readonly signal?: AbortSignal | undefined
}

/** One entry of a tier directory, loadable or not. */
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
  readonly issues: readonly SkillDocumentIssue[]
}

/** Complete listing of one tier directory. */
export interface SkillTierListing {
  /** Tier that was inspected. */
  readonly tier: SkillTierKind
  /** Absolute directory that was inspected. */
  readonly directory: string
  /** Entries in directory order, each with its loadability. */
  readonly entries: readonly SkillTierEntry[]
}

/** One extracted bundle file. */
interface BundleFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** One installed skill as the tier directory holds it. */
interface HeldSkill {
  readonly directory: string
  readonly name: string
}

/** `ctx.skillInstall` service: installs, replaces, and removes skill bundles in an ambient tier. */
export class SkillInstallService extends Service {
  /**
   * @param ctx - Cordis context carrying the skill registry this service refreshes.
   * @param config - resolved bundle bounds.
   */
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx, 'skillInstall')
  }

  /**
   * Install one skill bundle into an ambient tier, replacing any existing skill
   * of the same name when the request allows it. The bundle is validated in
   * full before the tier directory changes at all, and the refreshed catalog is
   * read afterwards so the result reports whether the skill is now discoverable.
   * @param request - tier, zip bytes, and whether replacement is allowed.
   * @returns the installed skill and whether the refreshed catalog lists it.
   * @throws SkillInstallError when the tier, the archive, or the skill document is refused.
   */
  async install(request: SkillInstallRequest): Promise<SkillInstallResult> {
    request.signal?.throwIfAborted()
    const directory = this.tierDirectory(request.tier)
    const parsed = readBundleDocument(readBundle(request.bundle, this.config))
    const target = join(directory, parsed.document.name)
    const staging = join(directory, `${STAGING_PREFIX}${parsed.document.name}-${randomUUID()}`)
    const replaced = await stage(staging, parsed.files, request.replace === true, target, request.signal)
    return {
      tier: request.tier,
      name: parsed.document.name,
      directory: target,
      replaced,
      files: parsed.files.map(file => file.path).sort(),
      visible: await this.refreshAndDetect(parsed.document.name),
    }
  }

  /**
   * Remove one skill from an ambient tier, accepting either its frontmatter
   * name or the directory name holding it, and refresh every cached catalog.
   * @param request - tier and the skill to remove.
   * @returns the removed directory and whether the refreshed catalog still lists the name.
   * @throws SkillInstallError when the tier is unavailable, the skill is absent, or two directories claim the name.
   */
  async remove(request: SkillRemoveRequest): Promise<SkillRemoveResult> {
    request.signal?.throwIfAborted()
    const held = await this.resolveHeld(request.name, this.tierDirectory(request.tier), request.signal)
    await rm(held.directory, { recursive: true, force: false })
    return {
      tier: request.tier,
      name: held.name,
      directory: held.directory,
      visible: await this.refreshAndDetect(held.name),
    }
  }

  /**
   * List one tier directory with each entry's loadability, so a skill placed by
   * hand is reported with the coded reasons it never reaches the catalog.
   * @param request - tier to inspect.
   * @returns the tier directory and its entries.
   * @throws SkillInstallError when the tier is unavailable.
   */
  async list(request: SkillListRequest): Promise<SkillTierListing> {
    request.signal?.throwIfAborted()
    const directory = this.tierDirectory(request.tier)
    const entries: SkillTierEntry[] = []
    for (const entry of await readTierEntries(directory)) {
      request.signal?.throwIfAborted()
      const path = entry.isDirectory()
        ? join(directory, entry.name, SKILL_ENTRY)
        : entry.isFile() && entry.name.endsWith('.md') ? join(directory, entry.name) : undefined
      if (path === undefined) continue
      entries.push(await readTierEntry(entry.name, path))
    }
    return { tier: request.tier, directory, entries }
  }

  /**
   * Resolve the ambient directory of one tier.
   * @param tier - tier kind named by the request.
   * @returns the absolute tier directory.
   * @throws SkillInstallError when no ambient provider or no such root exists.
   */
  private tierDirectory(tier: SkillTierKind): string {
    const provider = this.ctx.get('skillTiers')
    const roots = provider?.roots() ?? []
    const root = roots.find(candidate => candidate.kind === tier)
    if (root === undefined) {
      const kinds = roots.map(candidate => candidate.kind)
      throw new SkillInstallError(
        'tier-unavailable',
        kinds.length === 0
          ? `no ambient skill tier publishes "${tier}"; mount a skill tier provider`
          : `no ambient skill tier publishes "${tier}"; this scope publishes ${kinds.join(', ')}`,
        { tier, kinds },
      )
    }
    return root.path
  }

  /**
   * Resolve the directory holding one skill, by directory name first and then by
   * the frontmatter name each directory's document registers under.
   * @param name - skill name or directory name.
   * @param directory - tier directory to search.
   * @param signal - cancels the search.
   * @returns the directory holding the skill and the name it registers under.
   * @throws SkillInstallError when the skill is absent or two directories claim the name.
   */
  private async resolveHeld(name: string, directory: string, signal: AbortSignal | undefined): Promise<HeldSkill> {
    const literal = join(directory, name)
    if (isSkillName(name) && await holdsSkill(literal)) {
      /* v8 ignore next -- holdsSkill read this file a moment ago; an empty document needs the file to vanish between reads. */
      const document = readSkillDocument(await readText(join(literal, SKILL_ENTRY)) ?? '')
      return { directory: literal, name: document.ok ? document.document.name : name }
    }
    const candidates: HeldSkill[] = []
    for (const entry of await readTierEntries(directory)) {
      signal?.throwIfAborted()
      if (!entry.isDirectory()) continue
      const candidate = join(directory, entry.name)
      const document = readSkillDocument(await readText(join(candidate, SKILL_ENTRY)) ?? '')
      if (document.ok && document.document.name === name) candidates.push({ directory: candidate, name })
    }
    if (candidates.length === 0) {
      throw new SkillInstallError('skill-absent', `no skill "${name}" is installed at ${directory}`, { name, directory })
    }
    if (candidates.length > 1) {
      throw new SkillInstallError(
        'skill-ambiguous',
        `${candidates.length} directories register the skill name "${name}"`,
        { name, candidates: candidates.map(candidate => candidate.directory) },
      )
    }
    return candidates[0] as HeldSkill
  }

  /**
   * Refresh every cached catalog and report whether the registry now lists one
   * skill name. Reading the catalog is what proves the installed document is
   * loadable in the running process, rather than only present on disk.
   * @param name - skill name to look for.
   * @returns whether the refreshed catalog lists the name.
   */
  private async refreshAndDetect(name: string): Promise<boolean> {
    this.ctx.skills.refresh()
    const catalog = await this.ctx.skills.list({})
    return catalog.some(entry => entry.name === name)
  }
}

/**
 * Register the skill bundle installation service.
 * @param ctx - Cordis context carrying the skill registry.
 * @param config - bundle bounds; both default to the documented caps.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new SkillInstallService(ctx, {
    maxBundleBytes: positive(config.maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES),
    maxExpandedBytes: positive(config.maxExpandedBytes, DEFAULT_MAX_EXPANDED_BYTES),
  })
}

/**
 * Write the extracted bundle into a staging directory and swap it into place.
 * A refusal leaves the tier directory exactly as it was: nothing is renamed
 * until every file is written, and a failed swap renames the earlier skill
 * back and drops the staging directory.
 * @param staging - staging directory inside the tier directory.
 * @param files - extracted bundle files.
 * @param replace - whether an existing same-name skill may be replaced.
 * @param target - final skill directory.
 * @param signal - cancels the write and the swap.
 * @returns whether an earlier skill at this name was replaced.
 * @throws SkillInstallError when the name is taken and replacement is not allowed.
 */
async function stage(
  staging: string,
  files: readonly BundleFile[],
  replace: boolean,
  target: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const held = await holdsSkill(target)
  if (held && !replace) {
    throw new SkillInstallError(
      'skill-exists',
      `${target} already holds a skill; repeat with replace to overwrite it`,
      { directory: target },
    )
  }
  try {
    for (const file of files) {
      signal?.throwIfAborted()
      const path = join(staging, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.bytes)
      signal?.throwIfAborted()
    }
    signal?.throwIfAborted()
    const aside = held ? join(dirname(target), `${REPLACED_PREFIX}${randomUUID()}`) : undefined
    if (aside !== undefined) await rename(target, aside)
    try {
      await rename(staging, target)
    } catch (error) {
      /* v8 ignore next 2 -- the target is free once the replaced skill moved aside; this rollback runs only on a filesystem failure. */
      if (aside !== undefined) await rename(aside, target)
      throw error
    }
    if (aside !== undefined) await rm(aside, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return held
}

/**
 * Extract one zip archive into its bundle files, refusing unsafe or oversized
 * archives while they are read so a hostile archive cannot exhaust memory.
 * @param bundle - the zip archive bytes.
 * @param config - resolved bundle bounds.
 * @returns the extracted files in archive order.
 * @throws SkillInstallError when the archive is oversized, unsafe, or unreadable.
 */
function readBundle(bundle: Uint8Array, config: ResolvedConfig): BundleFile[] {
  if (bundle.byteLength === 0) {
    throw new SkillInstallError('bundle-invalid', 'the bundle is empty')
  }
  if (bundle.byteLength > config.maxBundleBytes) {
    throw new SkillInstallError(
      'bundle-too-large',
      `the bundle is ${bundle.byteLength} bytes; the limit is ${config.maxBundleBytes}`,
      { bytes: bundle.byteLength, limit: config.maxBundleBytes },
    )
  }
  const files: BundleFile[] = []
  const seen = new Set<string>()
  let expanded = 0
  try {
    const unzip = new Unzip((file) => {
      const path = safeEntryPath(file.name)
      if (path !== undefined) {
        if (seen.has(path)) {
          throw new SkillInstallError('bundle-invalid', `the bundle repeats the entry "${path}"`, { entry: path })
        }
        if (seen.size + 1 > MAX_BUNDLE_ENTRIES) {
          throw new SkillInstallError(
            'bundle-too-large',
            `the bundle holds more than ${MAX_BUNDLE_ENTRIES} entries`,
            { limit: MAX_BUNDLE_ENTRIES },
          )
        }
        seen.add(path)
        /* v8 ignore next -- a zip header states its entry size; an omitted size falls back to the running total, which still bounds it. */
        const declared = file.originalSize ?? 0
        if (expanded + declared > config.maxExpandedBytes) {
          throw new SkillInstallError(
            'bundle-too-large',
            `the bundle expands beyond ${config.maxExpandedBytes} bytes`,
            { limit: config.maxExpandedBytes, entry: path },
          )
        }
      }
      const chunks: Uint8Array[] = []
      file.ondata = (error, chunk, final) => {
        if (error !== null) throw error
        // The declared per-entry size can lie, so the running total is the bound
        // that actually holds while the archive inflates.
        expanded += chunk.byteLength
        /* v8 ignore next 6 -- a truthful header matches the running total; this bound fires only when a header understates it. */
        if (expanded > config.maxExpandedBytes) {
          throw new SkillInstallError(
            'bundle-too-large',
            `the bundle expands beyond ${config.maxExpandedBytes} bytes`,
            { limit: config.maxExpandedBytes },
          )
        }
        if (path === undefined) return
        chunks.push(chunk)
        /* v8 ignore next -- an entry arrives in several chunks only while the archive is pushed in pieces; this reader pushes it whole. */
        if (final) files.push({ path, bytes: concat(chunks) })
      }
      file.start()
    })
    unzip.register(UnzipPassThrough)
    unzip.register(UnzipInflate)
    unzip.push(bundle, true)
  } catch (error) {
    if (error instanceof SkillInstallError) throw error
    throw new SkillInstallError('bundle-invalid', `the bundle is not a readable zip archive: ${String(error)}`)
  }
  return files
}

/**
 * Read the one skill document a bundle must hold, with the bundle files as the
 * skill directory stores them.
 * @param files - extracted bundle files.
 * @returns the parsed skill document and the files to write, wrapper stripped.
 * @throws SkillInstallError when the bundle holds no skill document, more than one, or an unloadable one.
 */
function readBundleDocument(files: readonly BundleFile[]): { document: SkillDocument; files: BundleFile[] } {
  const stripped = stripWrapper(files)
  const roots = stripped.filter(file => file.path === SKILL_ENTRY)
  const nested = stripped.filter(file => file.path.endsWith(`/${SKILL_ENTRY}`))
  if (roots.length === 0) {
    throw new SkillInstallError(
      'bundle-invalid',
      nested.length > 0
        ? `the bundle holds ${nested.length} nested skill documents; upload one skill per bundle`
        : `the bundle holds no ${SKILL_ENTRY} at its root`,
      { entries: stripped.map(file => file.path).slice(0, 32) },
    )
  }
  const document = readSkillDocument(new TextDecoder().decode((roots[0] as BundleFile).bytes))
  if (!document.ok) {
    throw new SkillInstallError(
      'skill-invalid',
      `${SKILL_ENTRY} cannot become a loadable skill: ${document.issues.map(issue => issue.code).join(', ')}`,
      { issues: document.issues },
    )
  }
  return { document: document.document, files: stripped }
}

/**
 * Strip one wrapping directory from every entry, the layout a `git archive` or a
 * hosting service produces, so a wrapped and an unwrapped bundle install alike.
 * @param files - extracted bundle files.
 * @returns the files with a common single wrapper directory removed.
 */
function stripWrapper(files: readonly BundleFile[]): BundleFile[] {
  const wrapper = commonWrapper(files)
  if (wrapper === undefined) return [...files]
  return files.map(file => ({ path: file.path.slice(wrapper.length + 1), bytes: file.bytes }))
}

/**
 * Resolve the single top-level directory holding every entry.
 * @param files - extracted bundle files.
 * @returns the wrapper directory name, or `undefined` when the entries are not all under one.
 */
function commonWrapper(files: readonly BundleFile[]): string | undefined {
  if (files.some(file => file.path === SKILL_ENTRY)) return undefined
  const heads = new Set(files.map(file => file.path.split('/')[0] as string))
  const head = [...heads][0]
  if (heads.size !== 1 || head === undefined || files.some(file => file.path === head)) return undefined
  return head
}

/**
 * Normalize one archive entry name into a bundle-relative path.
 * @param name - the entry name as the archive spells it.
 * @returns the normalized path, or `undefined` for a directory entry the bundle does not write.
 * @throws SkillInstallError when the entry is not a bundle-relative path.
 */
function safeEntryPath(name: string): string | undefined {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.endsWith('/')) return undefined
  const segments = normalized.split('/')
  const unsafe = normalized === ''
    || isAbsolute(normalized)
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes('\0')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
  if (unsafe) {
    throw new SkillInstallError('bundle-unsafe-entry', `the bundle entry "${name}" is not a bundle-relative path`, { entry: name })
  }
  const path = join(...segments)
  /* v8 ignore next 3 -- the guards above already reject every escaping form; this one covers platform-specific join behavior. */
  if (relative('.', path).startsWith('..')) {
    throw new SkillInstallError('bundle-unsafe-entry', `the bundle entry "${name}" escapes the skill directory`, { entry: name })
  }
  return segments.join('/')
}

/**
 * List a tier directory, treating an absent directory as an empty tier.
 * @param directory - absolute tier directory.
 * @returns the directory entries, or none when the directory does not exist yet.
 */
async function readTierEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Read one tier entry and classify its loadability.
 * @param entry - directory or file name inside the tier directory.
 * @param path - absolute path of the skill document to read.
 * @returns the entry with its coded issues.
 */
async function readTierEntry(entry: string, path: string): Promise<SkillTierEntry> {
  const raw = await readText(path)
  if (raw === undefined) {
    return {
      entry,
      loadable: false,
      issues: [{ code: 'frontmatter-missing', message: `${SKILL_ENTRY} is missing or unreadable` }],
    }
  }
  const document = readSkillDocument(raw)
  if (!document.ok) return { entry, loadable: false, issues: document.issues }
  return {
    entry,
    name: document.document.name,
    description: document.document.description,
    loadable: true,
    issues: [],
  }
}

/**
 * Read a file's text, treating an absent path as an absent document.
 * @param path - absolute file path.
 * @returns the file text, or `undefined` when the path holds no readable file.
 */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    /* v8 ignore next 3 -- every unreadable path a tier walk reaches is absent or a directory; a permission fault escapes instead. */
    if (code === 'ENOENT' || code === 'EISDIR') return undefined
    /* v8 ignore next -- a read fault other than a missing path escapes; no tier walk provokes one portably. */
    throw error
  }
}

/**
 * Report whether a directory holds a readable skill document.
 * @param directory - absolute directory to test.
 * @returns whether the directory holds a `SKILL.md` file.
 */
async function holdsSkill(directory: string): Promise<boolean> {
  return await readText(join(directory, SKILL_ENTRY)) !== undefined
}

/**
 * Join extracted chunks into one byte array.
 * @param chunks - the chunks of one entry, in arrival order.
 * @returns the complete entry bytes.
 */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

/**
 * Validate one configured byte bound.
 * @param value - configured value, when the deployment set one.
 * @param fallback - documented default.
 * @returns the validated bound.
 */
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`skill-install byte bounds must be positive integers, received ${value}`)
  }
  return value
}
