/**
 * Multi-tenant file surface (`ctx.tenantFsHttp`): one byte channel over the five
 * host directories a subject's work lives in, so a business client edits real
 * server-side files instead of the harness growing one API method per business
 * module — and without knowing where the harness keeps them.
 *
 * Every request authenticates through `ctx.tenantAuth`, resolves a member through
 * `ctx.tenants.resolveMember`, and then names a file as `/{prefix}/{scope}/{path}`:
 *
 * - `session/<sessionId>/<path>` — that session's working directory (writable)
 * - `user/<path>` — the subject's work directory in this case (writable)
 * - `case/<path>` — the case's work directory (read-only)
 * - `global/<path>` — the subject's cross-case work directory (read-only)
 * - `system/<path>` — the deployment's system tree (read-only)
 *
 * `GET` reads bytes, `HEAD` reads the headers (which carry the ETag), `PUT`
 * writes bytes, and `GET /{prefix}/{scope}?path=<dir>` lists a directory. The
 * ETag is derived from the file's size and modification time, so it changes on
 * any write: a client reads, edits, and writes back with `If-Match`, and a
 * concurrent writer makes that write answer `412` instead of silently winning.
 * The surface stores no state — the filesystem is the only record, which is what
 * makes the model's next read of the same path see the client's edit.
 *
 * Reads and writes are confined to the request's own scope root on the host: the
 * surface resolves `realpath` for the root and for the nearest existing ancestor
 * of the target, so neither `..` nor a symlink inside a writable directory can
 * reach outside it.
 *
 * @module @deepseek-ai/dsh-tenant-fs-http
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { bridgeFetchRequest } from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { TenantError, UserId } from '@deepseek-ai/dsh-tenant'
import { TenantAuthError } from '@deepseek-ai/dsh-tenant-auth'
import z from '@deepseek-ai/schemastery'
import { decodeSegments, plainSegments, resolveTarget, scopeRoots } from './roots.ts'
import type { FileScope, ScopeRoot, Target } from './roots.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenantFsHttp: TenantFsHttp
  }
}

/** Prefix the surface answers on by default. */
const DEFAULT_PATH = '/files'

/** Default cap for one `PUT` body: a report or a document, not a disk image. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** Name suffix the surface writes through before renaming into place. */
const TEMP_SUFFIX = '.dsh-tmp.'

/** Content types the surface names; anything else is served as bytes. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.yaml', 'application/yaml; charset=utf-8'],
  ['.yml', 'application/yaml; charset=utf-8'],
])

/** Surface configuration. */
export interface Config {
  /** Prefix the surface answers on. */
  path?: string
  /** Deployment root of the cross-case work directories; without it the `global` scope is unavailable. */
  usersRoot?: string
  /** Deployment root of the system tree; without it the `system` scope is unavailable. */
  systemRoot?: string
  /** Largest accepted `PUT` body in bytes. */
  maxBytes?: number
}

/** One entry of a directory listing. */
export interface DirectoryEntry {
  /** Entry name inside the listed directory. */
  name: string
  /** What the entry is. */
  type: 'file' | 'dir' | 'other'
  /** Byte size, for a file. */
  size?: number
  /** Modification time in epoch milliseconds. */
  modifiedAt?: number
  /** Current ETag, for a file: the value a `PUT` returns for `If-Match`. */
  etag?: string
}

/** Multi-tenant file surface registered as `ctx.tenantFsHttp`. */
export class TenantFsHttp extends Service {
  static inject = ['tenantAuth', 'tenants']
  static Config: z<Config> = z.object({
    path: z.string().default(DEFAULT_PATH),
    usersRoot: z.string(),
    systemRoot: z.string(),
    maxBytes: z.natural().min(1).default(DEFAULT_MAX_BYTES),
  })

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'tenantFsHttp')
    // The route is an optional-server contribution: a headless context still
    // serves `fetch` for in-process callers, and a context with a `webServer`
    // also answers HTTP on the same prefix.
    ctx.inject(['webServer'], (webCtx) => {
      const route: WebRoute = {
        kind: 'prefix',
        path: this.prefix,
        handler: (req, res) => bridgeFetchRequest(req, res, { fetch: request => this.fetch(request) }, this.limit),
      }
      webCtx.effect(() => webCtx.webServer.register(route), 'tenant-fs-http: file route')
    })
  }

  /** The prefix this surface answers on, without a trailing slash. */
  get prefix(): string {
    const configured = (this.config.path ?? DEFAULT_PATH).trim()
    const trimmed = configured.endsWith('/') ? configured.slice(0, -1) : configured
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  }

  /** The largest accepted body. */
  private get limit(): number {
    return this.config.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * Authenticate one request, resolve the tenant and subject it acts for, and
   * answer it from that subject's own scope roots.
   * @param request - the incoming request; its `authorization` header carries the bearer token.
   * @returns the file response, or a fail-closed 401/403/500.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      const principal = await this.ctx.tenantAuth.authenticate(request.headers.get('authorization') ?? '')
      const tenantId = principal.tenantId
      // A platform credential proves no tenant, so it addresses no file: every
      // scope hangs off a tenant record and a subject.
      if (tenantId === undefined) {
        throw new TenantAuthError('INVALID_TOKEN', '文件面需要租户作用域的凭据')
      }
      const subject = UserId(principal.subject)
      const tenant = this.ctx.tenants.resolveMember(tenantId, subject)
      const roots = scopeRoots({
        tenant,
        subject,
        usersRoot: this.config.usersRoot,
        systemRoot: this.config.systemRoot,
      })
      return await this.serve(request, roots)
    } catch (error: unknown) {
      if (error instanceof TenantAuthError) {
        return jsonError(401, error.code, error.message, { 'www-authenticate': 'Bearer' })
      }
      if (error instanceof TenantError) return jsonError(403, error.code, error.message)
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      return jsonError(500, 'internal', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Dispatch one authenticated request to a read, a write, or a listing.
   * @param request - the authenticated request.
   * @param roots - the scope table for the request's (tenant, subject).
   * @returns the response for that operation.
   */
  private async serve(request: Request, roots: ReadonlyMap<FileScope, ScopeRoot>): Promise<Response> {
    const url = new URL(request.url)
    const prefix = this.prefix
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      return jsonError(404, 'file-not-found', `不在 ${prefix} 之下：${url.pathname}`)
    }
    const method = request.method
    if (method !== 'GET' && method !== 'HEAD' && method !== 'PUT') {
      return jsonError(405, 'method-not-allowed', `${method} 不支持：文件面只有 GET、HEAD 与 PUT`, { allow: 'GET, HEAD, PUT' })
    }
    const raw = url.pathname.slice(prefix.length).split('/').filter(segment => segment.length > 0)
    const scope = raw[0]
    if (scope === undefined) {
      return jsonError(400, 'file-path-invalid', `缺少作用域段：应形如 ${prefix}/<session|user|case|global|system>/<path>`)
    }
    // A bare scope path lists a directory; any deeper path names an entry. The
    // listing carries its directory in `?path=`, which arrives already decoded.
    if (raw.length === 1) {
      if (method === 'PUT') return jsonError(400, 'file-path-invalid', '要写的文件需要一个名字，不能写整个作用域')
      const requested = plainSegments((url.searchParams.get('path') ?? '').split('/'))
      return await this.list(roots, scope, requested)
    }
    const segments = decodeSegments(raw.slice(1))
    if (method === 'PUT') return await this.put(request, roots, scope, segments)
    return await this.read(request, roots, scope, segments, method === 'HEAD')
  }

  /**
   * List one directory inside a scope.
   * @param roots - the scope table for the request.
   * @param scope - the scope name from the URL.
   * @param requested - the directory's segments, or `undefined` when one is unsafe.
   * @returns a JSON listing, or the failure for that path.
   */
  private async list(
    roots: ReadonlyMap<FileScope, ScopeRoot>,
    scope: string,
    requested: readonly string[] | undefined,
  ): Promise<Response> {
    const target = await resolveTarget(roots, scope, requested)
    if (!target.ok) return failureResponse(target)
    const info = await statOrUndefined(target.hostPath)
    if (info === undefined) return jsonError(404, 'file-not-found', `${target.root.scope} 作用域里没有这个目录：${target.relative}`)
    if (!info.isDirectory()) {
      return jsonError(409, 'file-not-directory', `${target.relative} 是文件不是目录：直接 GET ${this.prefix}/${target.root.scope}/${target.relative} 读它`)
    }
    const entries: DirectoryEntry[] = []
    for (const dirent of await readdir(target.hostPath, { withFileTypes: true })) {
      // A write in flight is not an entry the client should see or address.
      if (dirent.name.includes(TEMP_SUFFIX)) continue
      const entryPath = join(target.hostPath, dirent.name)
      const entryStat = await statOrUndefined(entryPath)
      if (entryStat === undefined) continue
      entries.push(describe(dirent.name, entryStat, dirent.isDirectory()))
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    return json(200, {
      scope: target.root.scope,
      path: target.relative,
      writable: target.root.writable,
      entries,
    })
  }

  /**
   * Read one file, or answer `304` when the client already has this version.
   * @param request - the request, whose `if-none-match` may name its cached version.
   * @param roots - the scope table for the request.
   * @param scope - the scope name from the URL.
   * @param segments - the file's segments, or `undefined` when one is unsafe.
   * @param headOnly - answer the headers without the body.
   * @returns the file bytes, or the failure for that path.
   */
  private async read(
    request: Request,
    roots: ReadonlyMap<FileScope, ScopeRoot>,
    scope: string,
    segments: readonly string[] | undefined,
    headOnly: boolean,
  ): Promise<Response> {
    const target = await resolveTarget(roots, scope, segments)
    if (!target.ok) return failureResponse(target)
    if (target.relative === '') {
      return jsonError(400, 'file-path-invalid', `要读的文件需要一个名字；列目录用 GET ${this.prefix}/${target.root.scope}`)
    }
    const info = await statOrUndefined(target.hostPath)
    if (info === undefined) return jsonError(404, 'file-not-found', `${target.root.scope} 作用域里没有这个文件：${target.relative}`)
    if (info.isDirectory()) {
      return jsonError(409, 'file-is-directory', `${target.relative} 是目录；列目录用 GET ${this.prefix}/${target.root.scope}?path=${target.relative}`)
    }
    const etag = etagOf(info)
    const headers: Record<string, string> = {
      etag,
      'last-modified': new Date(Number(info.mtimeMs)).toUTCString(),
      'cache-control': 'private, no-cache',
    }
    if (matches(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers })
    }
    headers['content-type'] = contentTypeOf(target.relative)
    headers['content-length'] = info.size.toString()
    if (headOnly) return new Response(null, { status: 200, headers })
    const body = Readable.toWeb(createReadStream(target.hostPath)) as unknown as ReadableStream<Uint8Array>
    return new Response(body, { status: 200, headers })
  }

  /**
   * Write one file under an `If-Match` precondition.
   * @param request - the request whose body is the new content.
   * @param roots - the scope table for the request.
   * @param scope - the scope name from the URL.
   * @param segments - the file's segments, or `undefined` when one is unsafe.
   * @returns the new version's size and ETag, or the failure for that path.
   */
  private async put(
    request: Request,
    roots: ReadonlyMap<FileScope, ScopeRoot>,
    scope: string,
    segments: readonly string[] | undefined,
  ): Promise<Response> {
    const target = await resolveTarget(roots, scope, segments)
    if (!target.ok) return failureResponse(target)
    const root = target.root
    if (!root.writable) {
      return jsonError(403, 'file-readonly', `${root.scope} 作用域是只读的：${root.dir} 由业务侧或运维写入，沙箱与前端都只读`)
    }
    const relative = splitRelative(target.relative)
    if (relative.length === 0) {
      return jsonError(400, 'file-path-invalid', `要写的文件需要一个名字；不能写整个 ${root.scope} 作用域`)
    }
    // A session writes inside a session that exists: the platform creates those
    // directories, so a client cannot mint one by writing into it.
    if (root.scope === 'session') {
      const [sessionId, ...rest] = relative
      if (sessionId === undefined || rest.length === 0) {
        return jsonError(400, 'file-path-invalid', '会话作用域要写成 <sessionId>/<文件路径>；会话目录本身不是文件')
      }
      const sessionDir = await statOrUndefined(join(root.dir, sessionId))
      if (sessionDir === undefined || !sessionDir.isDirectory()) {
        return jsonError(404, 'file-session-unknown', `没有这个会话目录：${sessionId}（会话目录由会话启动时创建）`)
      }
    }
    const current = await statOrUndefined(target.hostPath)
    if (current !== undefined && current.isDirectory()) {
      return jsonError(409, 'file-is-directory', `${target.relative} 是目录，不能当文件写`)
    }
    const conflict = precondition(request.headers.get('if-match'), current)
    if (conflict !== undefined) return conflict
    const bounded = await this.body(request)
    if (bounded instanceof Response) return bounded
    // Write beside the target and rename into place: a reader either sees the old
    // file or the new one, never a half-written one, and an interrupted write
    // leaves nothing behind that a listing would surface.
    await mkdir(dirname(target.hostPath), { recursive: true })
    const temp = join(dirname(target.hostPath), `.${basename(target.hostPath)}${TEMP_SUFFIX}${randomBytes(6).toString('hex')}`)
    try {
      await writeFile(temp, bounded)
      await rename(temp, target.hostPath)
    } catch (error: unknown) {
      await unlink(temp).catch(() => {
        // The temp file is already gone when the write itself failed; nothing else can be left to clean.
      })
      throw error
    }
    const written = await stat(target.hostPath, { bigint: true })
    const etag = etagOf(written)
    return json(200, { scope: root.scope, path: target.relative, size: Number(written.size), etag }, { etag })
  }

  /**
   * Read the request body under the byte cap.
   * @param request - the request to read.
   * @returns the body, or the `413` response to answer instead.
   */
  private async body(request: Request): Promise<Buffer | Response> {
    const declared = request.headers.get('content-length')
    if (declared !== null && Number(declared) > this.limit) {
      return jsonError(413, 'file-too-large', `请求体 ${declared} 字节超过上限 ${this.limit}（maxBytes）`)
    }
    const buffer = Buffer.from(await request.arrayBuffer())
    if (buffer.byteLength > this.limit) {
      return jsonError(413, 'file-too-large', `请求体 ${buffer.byteLength} 字节超过上限 ${this.limit}（maxBytes）`)
    }
    return buffer
  }
}

/**
 * Split one relative path into its segments, as already validated by `resolveTarget`.
 * @param relative - the `/`-joined relative path.
 * @returns its segments.
 */
function splitRelative(relative: string): string[] {
  return relative.length === 0 ? [] : relative.split('/')
}

/**
 * Evaluate one `If-Match` precondition against the current file.
 * @param header - the `If-Match` header, or null when the client sent none.
 * @param current - the file as it is now, or undefined when it does not exist.
 * @returns the `412` response to answer, or undefined to proceed.
 */
function precondition(header: string | null, current: BigIntStats | undefined): Response | undefined {
  if (header === null) return undefined
  if (header.trim() === '*') {
    if (current === undefined) return jsonError(412, 'file-conflict', 'If-Match: * 要求这个文件已经存在')
    return undefined
  }
  const wanted = header.trim().replace(/^W\//, '')
  const actual = current === undefined ? undefined : etagOf(current)
  if (actual === wanted) return undefined
  return jsonError(412, 'file-conflict', `文件已被改动：If-Match 是 ${wanted}，当前是 ${actual ?? '（不存在）'}；重新读取后再写`)
}

/**
 * Whether one `If-None-Match` header names the current version.
 * @param header - the header value, or null when absent.
 * @param etag - the current ETag.
 * @returns whether the client's copy is current.
 */
function matches(header: string | null, etag: string): boolean {
  if (header === null) return false
  return header.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === '*' || value.replace(/^W\//, '') === etag
  })
}

/**
 * Derive the ETag of one file version from its size and modification time.
 *
 * Both change on every write, and a rename into place changes the modification
 * time, so the value a client read back is the value its next `If-Match` must
 * repeat. A content digest would answer the same question; it would also make
 * every `GET` read the file twice.
 * @param info - the file's stat.
 * @returns the quoted ETag.
 */
function etagOf(info: BigIntStats): string {
  return `"${info.size.toString(16)}-${info.mtimeNs.toString(16)}"`
}

/**
 * Describe one directory entry for a listing.
 * @param name - the entry name.
 * @param info - its stat.
 * @param isDir - whether it is a directory.
 * @returns the entry.
 */
function describe(name: string, info: BigIntStats, isDir: boolean): DirectoryEntry {
  if (isDir) return { name, type: 'dir' }
  if (!info.isFile()) return { name, type: 'other' }
  return { name, type: 'file', size: Number(info.size), modifiedAt: Number(info.mtimeMs), etag: etagOf(info) }
}

/**
 * Name the content type of a path by its extension.
 * @param relative - the file's relative path.
 * @returns the content type, or `application/octet-stream`.
 */
function contentTypeOf(relative: string): string {
  return CONTENT_TYPES.get(extname(relative).toLowerCase()) ?? 'application/octet-stream'
}

/**
 * Stat one path, treating a missing path as absent rather than as an error.
 * @param path - the path to stat.
 * @returns its stat, or undefined when nothing is there.
 */
async function statOrUndefined(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error: unknown) {
    // Only "nothing is here" is an ordinary answer. A permission or I/O error is
    // the operation's own failure and must not be reported as a missing file.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * Map one path-resolution failure onto its response.
 * @param target - the failed target.
 * @returns the response to answer.
 */
function failureResponse(target: Extract<Target, { ok: false }>): Response {
  switch (target.code) {
    case 'file-path-invalid':
      return jsonError(400, target.code, target.message)
    case 'file-scope-unknown':
      return jsonError(404, target.code, target.message)
    case 'file-scope-unavailable':
    case 'file-root-missing':
      // A configured root that is not on disk is a deployment error: answering
      // 404 would report an empty scope the deployment never created.
      return jsonError(503, target.code, target.message)
    default:
      return jsonError(500, 'internal', '未知的路径解析结果')
  }
}

/**
 * Build one JSON response.
 * @param status - the HTTP status.
 * @param body - the JSON body.
 * @param headers - extra headers.
 * @returns the response.
 */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

/**
 * Build one error response.
 * @param status - the HTTP status.
 * @param code - the stable machine-readable code.
 * @param message - the human-readable explanation.
 * @param headers - extra headers.
 * @returns the response.
 */
function jsonError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message } }, headers)
}

export default TenantFsHttp
