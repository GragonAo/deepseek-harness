/**
 * File-backed settings provider. One YAML or JSON document under the user's
 * harness home carries every namespace section; external edits hot-publish
 * through the seam, and every write re-reads the document under a
 * cross-process writer lock before patching it as a comment-preserving
 * leaf-level diff. Without an explicit `path`, the document lives under the
 * ambient tenant's `dataRoot` (or the harness home outside any tenant scope),
 * so each tenant stores its own `settings.yaml`.
 * @module @deepseek-ai/dsh-settings-file
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { currentTenant } from '@deepseek-ai/dsh-tenant'
import { SettingsProvider, deepEqualJson, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Settings document path; when set this is a fixed global file, tenant-independent. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/** Document format derived from the file extension. */
type SettingsFormat = 'yaml' | 'json'

const FORMATS: Record<string, SettingsFormat> = {
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  /** Fixed document path when `config.path` was set; `undefined` scopes per tenant. */
  explicitPath: string | undefined
  /** Resolved harness home; the non-tenant fallback root when no explicit path. */
  home: string
  watch: boolean
  debounceMs: number
}

/**
 * Resolve the runtime spec from plugin config: an explicit `path` wins,
 * otherwise the document lives at `<tenant dataRoot>/settings.yaml` inside a
 * tenant scope and `<harness home>/settings.yaml` outside one.
 * @param config - raw plugin config.
 * @returns the resolved location flags and watch behavior.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const explicitPath = config.path === undefined ? undefined : resolve(config.path)
  if (explicitPath !== undefined && FORMATS[extname(explicitPath)] === undefined) {
    throw new Error(`settings-file: extension "${extname(explicitPath)}" is not supported (use .yaml, .yml, or .json)`)
  }
  return {
    explicitPath,
    home: resolveDshHome(config.dshHome),
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/**
 * Resolve the active document filename for one call: a fixed `config.path`
 * when set, otherwise `<tenant.dataRoot>/settings.yaml` inside a tenant scope
 * and `<harness home>/settings.yaml` outside one.
 * @param config - raw plugin config.
 * @returns the absolute active document path.
 */
export function resolveActiveFilename(config: Config): string {
  if (config.path !== undefined) return resolve(config.path)
  return resolve(join(currentTenant()?.dataRoot ?? resolveDshHome(config.dshHome), 'settings.yaml'))
}

/** Derive the document format from a filename's extension, failing loud. */
function formatOf(filename: string): SettingsFormat {
  const format = FORMATS[extname(filename)]
  if (format === undefined) {
    throw new Error(`settings-file: extension "${extname(filename)}" is not supported (use .yaml, .yml, or .json)`)
  }
  return format
}

/** Whether a parsed YAML value is a map for diffing purposes. */
function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Apply the difference between one node's stored and next value as minimal
 * `setIn`/`deleteIn` edits, recursing through maps, so every untouched node —
 * and the key node of every changed pair — keeps its comments, anchors, and
 * formatting. Non-map values (arrays and scalars) replace wholesale when
 * unequal, taking any comments inside them along.
 */
function patchNode(document: Document, path: readonly string[], current: unknown, next: unknown): void {
  if (isMapLike(current) && isMapLike(next)) {
    for (const key of Object.keys(current)) {
      if (!(key in next)) document.deleteIn([...path, key])
    }
    for (const [key, value] of Object.entries(next)) {
      patchNode(document, [...path, key], current[key], value)
    }
    return
  }
  if (!deepEqualJson(current, next)) document.setIn([...path], next)
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether an exclusive file create found an existing document. */
function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/** File-backed settings provider (`settings.yaml`/`.json`), tenant-scoped by default. */
export class FileSettingsProvider extends SettingsProvider {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  /**
   * Raw text of the last successfully parsed or persisted document per
   * filename; `undefined` while that file is absent. A watcher event whose
   * content equals this cache is a no-op, which is also the self-write
   * suppression.
   */
  private readonly texts = new Map<string, string | undefined>()
  /**
   * Single exclusive operation chain: watcher reloads and document writes run
   * one at a time in queue order (settled tail), so a write can never render
   * from text a concurrent reload is busy replacing, and a reload can never
   * read a half-committed write.
   */
  private operations: Promise<void> = Promise.resolve()
  /** Chokidar watchers by filename, lazily created; dispose closes every one. */
  private readonly watchers = new Map<string, ReturnType<typeof chokidarWatch>>()
  /** Set at dispose: refuse new watcher events and let in-flight work no-op. */
  private closed = false

  /** Opaque read of {@link closed}: control flow cannot narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed
  }

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  /** Whether this provider resolves one document per ambient tenant. */
  override get tenantScoped(): boolean {
    return this.spec.explicitPath === undefined
  }

  /** The local document is always writable through {@link SettingsProvider.update}. */
  get writable(): boolean {
    return true
  }

  /** The document path for the ambient tenant (or the harness home), exposed to surfaces. */
  override get documentPath(): string {
    return this.activeFilename()
  }

  /** Resolve the document filename for the ambient scope at this instant. */
  private activeFilename(): string {
    if (this.spec.explicitPath !== undefined) return this.spec.explicitPath
    return resolve(join(currentTenant()?.dataRoot ?? this.spec.home, 'settings.yaml'))
  }

  /** The active document filename and the tenant key it belongs to. */
  private activeTarget(): { filename: string; key: string } {
    return { filename: this.activeFilename(), key: this.scopeKey() }
  }

  /** Materialize an absent owner-only document, then return its active path. */
  override prepareDocument(): Promise<string> {
    return this.enqueue(async () => {
      const { filename, key } = this.activeTarget()
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
      await withFileLock(filename, async () => {
        try {
          await writeFile(filename, '', { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (isEEXIST(error)) return
          throw error
        }
        this.texts.set(filename, '')
        if (!this.isClosed()) this.publishFor(key, {})
      })
      void this.watchFile(filename, key).catch((error: unknown) => {
        this.ctx.logger.warn('settings-file: failed to watch %s', filename)
        this.ctx.logger.warn(error)
      })
      return filename
    })
  }

  protected async load(): Promise<Record<string, unknown>> {
    const filename = this.activeFilename()
    let text: string
    try {
      text = await readFile(filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.texts.set(filename, undefined)
      return {}
    }
    const doc = this.parse(text, filename)
    this.texts.set(filename, text)
    return doc
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // One document backs every namespace, so writes from different namespace
    // queues serialize with each other and with watcher reloads on the one
    // operation chain: each render must see the text the previous operation
    // committed, or a sibling section silently vanishes from disk.
    return this.enqueue(() => this.persistSection(ns, section))
  }

  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Queue a reload; only an invariant violation escaping a commit can reject it. */
  private queueRefresh(filename: string, key: string): void {
    void this.enqueue(() => this.refresh(filename, key)).catch((error: unknown) => {
      // Only an invariant violation escaping the commit path can reject a
      // refresh; keep the operation queue alive and surface it as an error so
      // one poisoned commit cannot silently end hot reloading forever.
      this.ctx.logger.error('settings-file: reload commit failed at %s', filename)
      this.ctx.logger.error(error)
    })
  }

  /**
   * Lazily create (or reuse) the watcher for one document filename. The
   * `key` binds later events to the tenant that filename belongs to, even
   * though a detached watcher event fires outside any request scope.
   * @param filename - absolute document path to watch.
   * @param key - the tenant key the filename is scoped to ('' = global).
   */
  private async watchFile(filename: string, key: string): Promise<void> {
    if (!this.spec.watch || this.closed || this.watchers.has(filename)) return
    const watcher = chokidarWatch(await canonicalizeWatchPath(filename), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.spec.debounceMs,
        pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
      },
    })
    this.watchers.set(filename, watcher)
    watcher.on('all', () => {
      if (this.closed) return
      this.queueRefresh(filename, key)
    })
    watcher.on('ready', () => {
      // The initial load raced the watcher's own setup: a change written
      // between that read and the watcher becoming active never fires an
      // event. One reconcile at ready closes the gap.
      if (this.closed) return
      this.queueRefresh(filename, key)
    })
    watcher.on('error', (error) => {
      this.ctx.logger.warn('settings-file: watcher error on %s', filename)
      this.ctx.logger.warn(error)
    })
  }

  private async persistSection(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    const { filename, key } = this.activeTarget()
    // The writer lock's exclusive create needs the parent to exist before
    // writeFileAtomic gets its own chance to create it.
    // 0700: the harness home holds user-private documents.
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    await withFileLock(filename, async () => {
      // Read-modify-write: fold in any on-disk state this process has not
      // observed yet — an external edit still inside the watcher debounce
      // window, a change the watcher missed, or another process's write — so
      // the render below can never resurrect a stale document. An unparsable
      // on-disk document fails the write loud instead of silently overwriting
      // a user's manual edit.
      await this.reconcileFromDisk(filename, key)
      const output = formatOf(filename) === 'yaml'
        ? this.renderYaml(ns, section, filename)
        : this.renderJson(ns, section, filename)
      // 0600: a document that may hold personal values is never world-readable.
      await writeFileAtomic(filename, output, { mode: 0o600, dirMode: 0o700 })
      this.texts.set(filename, output)
    })
    void this.watchFile(filename, key).catch((error: unknown) => {
      this.ctx.logger.warn('settings-file: failed to watch %s', filename)
      this.ctx.logger.warn(error)
    })
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // The base init loads and publishes; a parse failure there is a boot
    // failure: an existing-but-invalid document must fail loud, never be
    // silently ignored or overwritten.
    yield* super[Service.init]()
    const { filename, key } = this.activeTarget()
    await this.watchFile(filename, key)
    yield async () => {
      // Quiesce every operation chain, even when no watcher is configured.
      this.closed = true
      await Promise.all([...this.watchers.values()].map(watcher => watcher.close()))
      await this.operations
    }
  }

  /** Parse one document text into raw sections, failing on a non-map root. */
  private parse(text: string, filename: string): Record<string, unknown> {
    let root: unknown
    if (formatOf(filename) === 'yaml') {
      // `prettyErrors` is on only for `linePos`; `error.message` is never
      // used, because the parser quotes the offending source line and a
      // settings document can hold a `role('secret')` value.
      const document = parseDocument(text, { prettyErrors: true })
      if (document.errors.length > 0) {
        throw new Error(`settings-file: invalid document at ${filename}: ${
          document.errors.map((error) => {
            const at = error.linePos?.[0]
            /* v8 ignore next -- `prettyErrors` populates linePos on every error; the guard answers its optional type */
            return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
          }).join('; ')}`)
      }
      root = document.toJS() ?? {}
    } else {
      root = text.trim().length === 0 ? {} : JSON.parse(text)
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new TypeError(`settings-file: ${filename} must be a map of namespace sections`)
    }
    return root as Record<string, unknown>
  }

  /**
   * Re-read one document after a watcher event. Unchanged content (including
   * this provider's own writes) is a no-op; an unreadable or unparsable
   * document keeps the last good sections and warns — a live hot-reload must
   * never take the process down. An invariant violation escaping a commit is
   * not a reload failure and propagates to the queue's error surface.
   */
  private async refresh(filename: string, key: string): Promise<void> {
    if (this.closed) return
    try {
      await this.reconcileFromDisk(filename, key)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') throw error
      this.ctx.logger.warn('settings-file: reload failed at %s; keeping the last good document', filename)
      this.ctx.logger.warn(error)
    }
  }

  /**
   * Compare one file's on-disk text against its cache and publish any
   * difference into the seam under `key`. Absence publishes the empty
   * document; an unreadable or unparsable file throws, so each caller picks
   * its policy — a reload warns and keeps the last good document, a write
   * fails loud.
   */
  private async reconcileFromDisk(filename: string, key: string): Promise<void> {
    let text: string | undefined
    try {
      text = await readFile(filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      text = undefined
    }
    if (text === this.texts.get(filename) || this.isClosed()) return
    if (text === undefined) {
      this.texts.set(filename, undefined)
      this.publishFor(key, {})
      return
    }
    const doc = this.parse(text, filename)
    this.texts.set(filename, text)
    this.publishFor(key, doc)
  }

  /**
   * Render the next YAML text by patching one namespace in the
   * comment-preserving document. The next section lands as a leaf-level diff
   * against the stored one — only changed values set, only removed keys
   * delete — so comments inside the section survive edits to their siblings,
   * not just comments outside it.
   */
  private renderYaml(ns: SettingsNamespace, section: Record<string, unknown>, filename: string): string {
    const text = this.texts.get(filename)
    if (text === undefined) {
      return new Document({ [ns]: section }).toString()
    }
    // The cached text only ever caches content that parsed successfully, so this
    // re-parse (for the mutable comment-preserving tree) cannot fail, and
    // parse() already rejected any non-map root.
    const document = parseDocument(text)
    const root: unknown = document.toJS()
    patchNode(document, [ns], isMapLike(root) ? root[ns] : undefined, section)
    return document.toString()
  }

  /** Render the next JSON text by replacing one namespace key. */
  private renderJson(ns: SettingsNamespace, section: Record<string, unknown>, filename: string): string {
    const text = this.texts.get(filename)
    const root = text === undefined
      ? {}
      : this.parse(text, filename)
    root[ns] = section
    return `${JSON.stringify(root, null, 2)}\n`
  }
}

export default FileSettingsProvider
