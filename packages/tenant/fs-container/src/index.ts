/**
 * Container provider for the filesystem capability seam (`ctx.fs`). Paths
 * resolve inside the ambient tenant's container — the same execution world the
 * subprocess provider serves — so file reads, listings, writes, and edits stay
 * within that tenant's isolation boundary.
 *
 * Relative paths resolve against the calling session's own directory
 * (`/sessions/<session id>`), the same place a shell command of that session
 * runs: `ContainerRuntime.exec` already overrides the caller's `cwd` with it,
 * and a relative path the caller hands to `resolve` is the same host-side guess
 * that override exists to discard. Without an ambient session — host tooling,
 * skill discovery, a caller that names its own cwd — the configured
 * {@link Config.root} stays in effect.
 * @module @deepseek-ai/dsh-fs-container
 */

import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ContainerCommandResult, ContainerExecOptions, ContainerRuntime } from '@deepseek-ai/dsh-container'
import { sandboxSessionDirOf } from '@deepseek-ai/dsh-tenant'
import type {} from '@deepseek-ai/dsh-agent'

/** Plugin configuration. */
export interface Config {
  /**
   * Container path relative requests resolve against when no ambient session
   * supplies one (the tenant workspace mount).
   */
  root?: string
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function signalOpts(signal: AbortSignal | undefined): ContainerExecOptions {
  return signal === undefined ? {} : { signal }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function fsInfoType(rawKind: string): FsInfo['type'] {
  if (rawKind === 'regular file' || rawKind === 'regular empty file') return 'file'
  if (rawKind === 'directory') return 'directory'
  return 'other'
}

function fsPathInfoType(rawKind: string): FsPathInfo['type'] {
  if (rawKind === 'regular file' || rawKind === 'regular empty file') return 'file'
  if (rawKind === 'directory') return 'directory'
  if (rawKind === 'symbolic link') return 'symlink'
  return 'other'
}

function decodeText(stdout: string, displayPath: string): string {
  if (stdout.includes('\0')) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  return stdout
}

interface StatLine {
  rawKind: string
  size: number | undefined
  version: FsVersion
}

/** Container filesystem provider registered as `ctx.fs`. */
export class ContainerFileSystem extends FileSystem {
  static inject = ['containerRuntime']
  static Config: z<Config> = z.object({
    root: z.string().default('/workspace'),
  })

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
  }

  private get rootPath(): string {
    return this.config.root ?? '/workspace'
  }

  private get runtime(): ContainerRuntime {
    return this.ctx.containerRuntime
  }

  /**
   * The calling session's own container directory, or `undefined` outside a
   * session. Mirrors the override `ContainerRuntime.exec` applies: the session
   * chooses the directory, and anything the caller passed is a path on its own
   * machine rather than one inside this container.
   * @returns `/sessions/<session id>` for an ambient session that can name a
   * directory, otherwise `undefined`.
   */
  private sessionDir(): string | undefined {
    try {
      const id = this.ctx.get('agents')?.currentInitiator()?.session.header.id
      return sandboxSessionDirOf(id === undefined ? undefined : String(id))
    } catch {
      // A disposed agent registry rejects every ambient read; a missing session
      // fact must not fail the file operation, so resolution falls back exactly
      // as it does outside any initiator boundary.
      return undefined
    }
  }

  private normalize(path: string, cwd: string): string {
    return posix.normalize(posix.isAbsolute(path) ? path : posix.join(cwd, path))
  }

  /**
   * The directory a relative path resolves against: the ambient session's own
   * directory first, then the caller's cwd, then the configured root.
   * @param cwd - the cwd the caller asked for, when it named one.
   * @returns the container path to join a relative request onto.
   */
  private baseDir(cwd: string | undefined): string {
    return this.sessionDir() ?? cwd ?? this.rootPath
  }

  private async statLine(path: string, follow: boolean, signal?: AbortSignal): Promise<StatLine | undefined> {
    const operation = follow ? 'stat -L' : 'stat'
    const result = await this.runtime.exec('sh', ['-c', `${operation} -c '%F|%s|%Y' ${quoteShell(path)}`], signalOpts(signal))
    if (result.exitCode !== 0) return undefined
    const parts = result.stdout.trim().split('|')
    const rawKind = parts[0] ?? ''
    const size = Number(parts[1])
    return {
      rawKind,
      size: Number.isFinite(size) ? size : undefined,
      version: FsVersion(parts.join('|')),
    }
  }

  private readError(result: ContainerCommandResult, displayPath: string): FsError {
    const stderr = result.stderr
    if (stderr.includes('No such file')) return new FsError(`file not found: ${displayPath}`, 'FS_NOT_FOUND')
    if (stderr.includes('Is a directory')) return new FsError(`not a regular file: ${displayPath}`, 'FS_NOT_REGULAR_FILE')
    return new FsError(`${displayPath}: ${stderr.trim() || `exit ${result.exitCode}`}`, 'FS_IO_ERROR')
  }

  private async readExisting(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    const info = await this.stat(target, signal)
    if (info === undefined) return null
    try {
      return await this.readText(target, signal)
    } catch (error: unknown) {
      if (error instanceof FsError && (error.code === 'FS_NOT_TEXT' || error.code === 'FS_NOT_REGULAR_FILE')) {
        return null
      }
      throw error
    }
  }

  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const resolved = this.normalize(path, this.baseDir(opts?.cwd))
    return Promise.resolve({ targetKey: FsTargetKey(resolved), displayPath: resolved })
  }

  processPath(target: FsTarget): string {
    return target.targetKey
  }

  fileUrl(target: FsTarget): string {
    return `file://${target.targetKey.split('/').map(encodeURIComponent).join('/')}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = String(parent.targetKey)
    const childPath = String(child.targetKey)
    return childPath === parentPath || childPath.startsWith(parentPath.endsWith('/') ? parentPath : `${parentPath}/`)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const line = await this.statLine(String(target.targetKey), true, signal)
    if (line === undefined) return undefined
    return { version: line.version, type: fsInfoType(line.rawKind), ...(line.size === undefined ? {} : { size: line.size }) }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const resolved = this.normalize(path, this.baseDir(opts?.cwd))
    const line = await this.statLine(resolved, false, signal)
    if (line === undefined) return undefined
    return { version: line.version, type: fsPathInfoType(line.rawKind), ...(line.size === undefined ? {} : { size: line.size }) }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const result = await this.runtime.exec('sh', ['-c', `cat ${quoteShell(String(target.targetKey))}`], signalOpts(signal))
    if (result.exitCode !== 0) throw this.readError(result, target.displayPath)
    // 容器侧上界截断过的 stdout 不是这个文件的内容，只是它的末尾一段：把一段残缺文本当成
    // 整份文件交给调用方，会让 `editText` 拿着错的 before 去改文件，所以这里只能失败。
    if (result.stdoutTruncated === true) {
      throw new FsError(`${target.displayPath} exceeds the sandbox output budget`, 'FS_TOO_LARGE')
    }
    return decodeText(result.stdout, target.displayPath)
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    let yielded = false
    return {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<string>> => {
            if (yielded) return Promise.resolve({ value: undefined, done: true })
            yielded = true
            return Promise.resolve({ value: text, done: false })
          },
        }
      },
    }
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`file not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`not a regular file: ${target.displayPath}`, 'FS_NOT_REGULAR_FILE')
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`${target.displayPath} exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    }
    const result = await this.runtime.exec('sh', ['-c', `base64 < ${quoteShell(String(target.targetKey))}`], signalOpts(signal))
    if (result.exitCode !== 0) throw this.readError(result, target.displayPath)
    // 同 `readText`：被截断的 base64 解出来的字节不是这个文件的字节。`stat` 报的大小能挡掉
    // 大部分超限文件，但上界由部署给出，比这里的 `maxBytes` 更小时只有这条标记能发现它。
    if (result.stdoutTruncated === true) {
      throw new FsError(`${target.displayPath} exceeds the sandbox output budget`, 'FS_TOO_LARGE')
    }
    const bytes = Buffer.from(result.stdout.replaceAll('\n', '').trim(), 'base64')
    if (bytes.length > maxBytes) throw new FsError(`${target.displayPath} exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    return bytes
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const script = `find ${quoteShell(String(target.targetKey))} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\n'`
    const result = await this.runtime.exec('sh', ['-c', script], signalOpts(signal))
    if (result.exitCode !== 0) {
      // A missing directory is absent state, not an I/O failure: `find` reports
      // it on stderr with a non-zero exit, so classify it before the fallback
      // the same way `readError` and `stat` do. Callers that treat an absent
      // root as empty (skill and tool discovery) rely on `FS_NOT_FOUND`.
      if (result.stderr.includes('No such file')) {
        throw new FsError(`directory not found: ${target.displayPath}`, 'FS_NOT_FOUND')
      }
      if (result.stderr.includes('Not a directory')) {
        throw new FsError(`not a directory: ${target.displayPath}`, 'FS_NOT_DIRECTORY')
      }
      throw new FsError(`${target.displayPath}: ${result.stderr.trim()}`, 'FS_IO_ERROR')
    }
    // 被截断的清单只是一部分条目，而调用方（技能发现、搜索）会把它当成这个目录的全部内容。
    if (result.stdoutTruncated === true) {
      throw new FsError(`${target.displayPath} listing exceeds the sandbox output budget`, 'FS_TOO_LARGE')
    }
    const entries: FsDirEntry[] = []
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue
      const [name, kind, sizeText] = line.split('\t')
      if (name === undefined) continue
      const childPath = posix.join(String(target.targetKey), name)
      const size = Number(sizeText)
      entries.push({
        name,
        type: kind === 'd' ? 'directory' : kind === 'f' ? 'file' : 'other',
        target: { targetKey: FsTargetKey(childPath), displayPath: childPath },
        ...(Number.isFinite(size) ? { size } : {}),
      })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    return entries
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted()
    const targetKey = String(target.targetKey)
    const before = await this.readExisting(target, signal)
    if (expected?.kind === 'createIfAbsent' && before !== null) {
      throw new FsError(`already exists: ${target.displayPath}`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      const info = await this.stat(target, signal)
      if (info === undefined) throw new FsError(`not observed: ${target.displayPath}`, 'FS_NOT_OBSERVED')
      if (info.version !== expected.version) throw new FsError(`stale version: ${target.displayPath}`, 'FS_STALE_VERSION')
    }
    const temporary = `${targetKey}.dsh-tmp`
    // The parent directory is created on demand, as `dsh-fs-local` does: a model writing its
    // first file into a directory that does not exist yet gets the file, not ENOENT.
    const script = `mkdir -p ${quoteShell(posix.dirname(targetKey))} && cat > ${quoteShell(temporary)} && mv ${quoteShell(temporary)} ${quoteShell(targetKey)}`
    const opts: ContainerExecOptions = { stdin: content }
    if (signal !== undefined) opts.signal = signal
    const result = await this.runtime.exec('sh', ['-c', script], opts)
    if (result.exitCode !== 0) throw this.readError(result, target.displayPath)
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`write verification failed: ${target.displayPath}`, 'FS_IO_ERROR')
    return {
      operation: before === null ? 'create' : 'update',
      version: info.version,
      before: before === null ? null : normalizeLineEndings(before),
      after: normalizeLineEndings(content),
    }
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    const before = normalizeLineEndings(await this.readText(target, signal))
    const oldString = normalizeLineEndings(edit.oldString)
    const occurrences = before.split(oldString).length - 1
    let after: string
    if (edit.replaceAll) {
      after = before.replaceAll(oldString, edit.newString)
    } else {
      if (occurrences === 0) throw new FsError(`match not found: ${target.displayPath}`, 'FS_EDIT_NOT_FOUND')
      if (occurrences > 1) throw new FsError(`ambiguous edit: ${target.displayPath}`, 'FS_AMBIGUOUS_EDIT')
      after = before.replace(oldString, edit.newString)
    }
    const intent: FsWriteIntent | undefined = expected === undefined
      ? undefined
      : { kind: 'replaceIfVersion', version: expected.version }
    const written = await this.writeText(target, after, intent, signal)
    return { version: written.version, before, after: normalizeLineEndings(written.after) }
  }
}

export default ContainerFileSystem
