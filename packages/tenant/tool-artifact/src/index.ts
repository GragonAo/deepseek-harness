/**
 * Artifact delivery for case-scoped deployments. Files the model writes inside its sandbox are
 * invisible to the user, because the sandbox is a container and the user's browser reaches the
 * deployment only through the web front end. This plugin copies a generated file into the case's
 * static directory — the one the front end serves — and hands the model the same-origin path and
 * the delivery tag its reply must carry.
 *
 * Publication is scoped twice: to the authenticated case (the tenant), and to the authenticated
 * subject (the user). A call reads only from the calling subject's own mounts, writes only below
 * that subject's own directory, and lists only its own published files, so one subject's artifacts
 * are neither listed nor addressable by another subject of the same case.
 * @module @deepseek-ai/dsh-tool-artifact
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, resolve as resolveHost } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireTenant, requireUser } from '@deepseek-ai/dsh-tenant'
import {
  ARTIFACT_KINDS,
  addressContainerPath,
  attachmentTag,
  deliveryName,
  formatStamp,
  isInside,
  kindForExtension,
  publicPathFor,
  sanitizeSegment,
  splitExtension,
} from './artifact-store.ts'
import type { ArtifactKind, Mount } from './artifact-store.ts'

/** Cordis plugin name. */
export const name = 'tool-artifact'
/** The tool registry the artifact tools are registered on. */
export const inject = ['tools']

/** Artifact delivery configuration. */
export interface Config {
  /** Absolute host directory the deployment's web front end serves as static files. */
  mediaRoot: string
  /**
   * The web front end's origin (scheme, host, and port — no path), used only to build the absolute
   * `url` for callers that need one (logs, curl, a non-browser client). The delivery tag never
   * carries it.
   */
  publicOrigin?: string
  /** Same-origin path prefix the front end serves {@link Config.mediaRoot} under. */
  urlPrefix: string
  /** Host root of the per-subject directories mounted at `/global`; omit when that mount is absent. */
  usersRoot?: string
  /** File published artifacts into a per-kind subdirectory instead of the case directory itself. */
  groupByKind: boolean
  /** Largest file this tool publishes, in bytes. */
  maxBytes: number
}

/** Schemastery configuration for the artifact tools. */
export const Config: z<Config> = z.object({
  mediaRoot: z.string().required(),
  publicOrigin: z.string(),
  urlPrefix: z.string().default('/media'),
  usersRoot: z.string(),
  groupByKind: z.boolean().default(true),
  maxBytes: z.number().default(100 * 1024 * 1024),
})

/** The deployment choices this plugin resolves once, at load. */
interface Policy {
  readonly mediaRoot: string
  readonly urlPrefix: string
  readonly publicOrigin: string | undefined
  readonly usersRoot: string | undefined
  readonly groupByKind: boolean
  readonly maxBytes: number
}

/**
 * Resolve the deployment's configuration into the values every call uses, so no call re-derives a
 * default.
 * @param config - the validated plugin configuration.
 * @returns the resolved policy.
 */
function resolvePolicy(config: Config): Policy {
  const urlPrefix = `/${config.urlPrefix.replace(/^\/+|\/+$/g, '')}`
  const origin = config.publicOrigin?.replace(/\/+$/, '')
  return {
    mediaRoot: resolveHost(config.mediaRoot),
    urlPrefix,
    publicOrigin: origin === undefined || origin === '' ? undefined : origin,
    usersRoot: config.usersRoot === undefined ? undefined : resolveHost(config.usersRoot),
    groupByKind: config.groupByKind,
    maxBytes: config.maxBytes,
  }
}

/** The case and subject one call acts as, and the mounts and destination they imply. */
interface CaseScope {
  /** Authenticated case id, as the static directory spells it. */
  readonly caseId: string
  /** Authenticated subject, as the static directory spells it. */
  readonly userId: string
  /** The mounts this call may read from, container path to host directory. */
  readonly mounts: readonly Mount[]
  /** Static directory holding this subject's published files. */
  readonly directory: string
}

/**
 * Resolve the calling request's case and subject authority.
 * @param policy - the resolved deployment policy.
 * @returns the case scope every path decision is made against.
 * @throws when the call runs outside a case-scoped request.
 */
function currentCase(policy: Policy): CaseScope {
  const tenant = requireTenant()
  const user = requireUser()
  const caseId = sanitizeSegment(tenant.id, 'case')
  const userId = sanitizeSegment(user, 'user')
  // These mounts mirror the ones the container provider binds for this subject; a path the sandbox
  // can write is exactly a path this tool can read.
  const mounts: Mount[] = [
    { container: '/workspace', host: resolveHost(tenant.workspaceRoot, 'users', user) },
    { container: '/shared', host: resolveHost(tenant.workspaceRoot, 'shared') },
  ]
  if (policy.usersRoot !== undefined) mounts.push({ container: '/global', host: resolveHost(policy.usersRoot, user) })
  return { caseId, userId, mounts, directory: join(policy.mediaRoot, caseId, userId) }
}

/** A source file a publish call may read. */
interface Source {
  /** Absolute host path, after symlinks were resolved. */
  readonly host: string
  /** The path as the model addresses it, for the result. */
  readonly containerPath: string
  /** Size in bytes. */
  readonly size: number
}

/**
 * Whether a filesystem failure means the path is absent. Only `ENOENT` reports absence:
 * `EACCES` (an unreadable component), `ELOOP` (a symlink loop), and `ENAMETOOLONG` (a name
 * the host cannot represent) are failures of a path that is not missing, so answering with
 * absence would report a specific, wrong conclusion.
 * @param error - the value a filesystem call rejected with.
 * @returns true when the failure is an absent path.
 */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Resolve a model-supplied path to a host file inside the calling subject's mounts.
 * @param scope - the calling case scope.
 * @param input - the model-supplied path.
 * @param cwd - the calling session's working directory.
 * @param maxBytes - the largest file this deployment publishes.
 * @returns the resolved source file.
 * @throws when the path leaves the subject's mounts, does not exist, is not a regular file, or is
 * larger than the deployment allows; a filesystem failure other than an absent path surfaces
 * unchanged, because only `ENOENT` means the file is not there.
 */
async function resolveSource(scope: CaseScope, input: string, cwd: string, maxBytes: number): Promise<Source> {
  const addressed = addressContainerPath(input, cwd, scope.mounts)
  if (addressed === null) {
    const readable = scope.mounts.map(mount => mount.container).join(', ')
    throw new Error(`file_path ${JSON.stringify(input)} is not inside the paths this subject can publish from (${readable})`)
  }
  const candidate = join(addressed.mount.host, addressed.relativePath)
  const root = await fs.realpath(addressed.mount.host)
  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch (error) {
    // `candidate` is the mount root — already resolved above — joined with the model's path, so
    // nothing about it is unknown except whether it is there: ENOENT is that absence.
    // An unreadable component (EACCES), a symlink loop (ELOOP), or an over-long name
    // (ENAMETOOLONG) reaches this call for a path that is not missing, and reporting any of them
    // as "does not exist" would hand the model a conclusion instead of the failure that happened.
    if (!isENOENT(error)) throw error
    throw new Error(`file_path ${JSON.stringify(addressed.containerPath)} does not exist`)
  }
  if (!isInside(root, real)) {
    throw new Error(`file_path ${JSON.stringify(addressed.containerPath)} resolves outside ${addressed.mount.container}`)
  }
  const info = await fs.stat(real)
  if (!info.isFile()) throw new Error(`file_path ${JSON.stringify(addressed.containerPath)} is not a regular file`)
  if (info.size > maxBytes) {
    throw new Error(`file_path ${JSON.stringify(addressed.containerPath)} is ${info.size} bytes, above this deployment's ${maxBytes}-byte limit`)
  }
  return { host: real, containerPath: addressed.containerPath, size: info.size }
}

/**
 * Copy one source file into the static directory under a name no other publish holds. The name is
 * claimed by creating the destination exclusively and then renaming the finished copy over it, so
 * two calls in the same second cannot overwrite each other and a reader never sees a partial file.
 * @param source - the resolved source file.
 * @param directory - the destination directory.
 * @param stamp - the publish timestamp.
 * @param stem - the sanitized file stem.
 * @param extension - the extension including its leading dot, or an empty string.
 * @returns the absolute path of the published file.
 */
async function publishInto(directory: string, source: Source, stamp: string, stem: string, extension: string): Promise<string> {
  const staging = join(directory, `.${stamp}.${randomUUID()}.part`)
  await fs.copyFile(source.host, staging)
  try {
    for (let attempt = 1; attempt <= 100; attempt++) {
      const destination = join(directory, deliveryName(stamp, stem, extension, attempt))
      try {
        const claim = await fs.open(destination, 'wx')
        await claim.close()
        await fs.rename(staging, destination)
        return destination
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error(`cannot allocate a delivery name for ${stem}${extension}`)
  } finally {
    // Best-effort removal of the staging file, and the one place this module swallows a failure
    // beyond absence. The success path renamed `staging` to `destination`, so ENOENT is what a
    // published artifact normally reports here; any other code (EACCES, EIO) leaves at most a
    // `.`-prefixed `.part` file that no reader opens and no listing reports, because the name is
    // never referenced. Cleanup cannot turn a failure into a success — the try above propagates
    // its own error first — and letting a cleanup failure out of this `finally` would replace a
    // returned destination with an error, reporting a delivered artifact as an undelivered one.
    await fs.unlink(staging).catch(() => undefined)
  }
}

/** One published artifact, as the list tool reports it. */
interface PublishedArtifact {
  readonly name: string
  readonly kind: string
  readonly public_path: string
  readonly bytes: number
  readonly modified: string
}

/**
 * Enumerate this subject's published artifacts, newest first.
 * @param scope - the calling case scope.
 * @param policy - the resolved deployment policy.
 * @param limit - the largest number of entries to return.
 * @returns the entries and the total number published.
 */
async function listPublished(scope: CaseScope, policy: Policy, limit: number): Promise<{ entries: PublishedArtifact[]; total: number }> {
  const entries: PublishedArtifact[] = []
  const collect = async (directory: string, kind: ArtifactKind | undefined, segments: string[]): Promise<void> => {
    // The subject's delivery directory does not exist until its first publish, and a subdirectory
    // named by the readdir that listed it a moment earlier can be gone before this call reaches it:
    // ENOENT is absence, which is an empty list. Every other code (EACCES, EIO, ENOTDIR) means the
    // read failed for some reason other than absence, and answering that with an empty list tells
    // the model it has delivered nothing — a wrong conclusion, not an empty result.
    const dirents = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (!isENOENT(error)) throw error
      return []
    })
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue
      if (dirent.isDirectory()) {
        await collect(join(directory, dirent.name), kind ?? (dirent.name as ArtifactKind), [...segments, dirent.name])
        continue
      }
      if (!dirent.isFile()) continue
      // The name came from this directory's own readdir a moment ago, so the entry existed: ENOENT
      // is a concurrent removal, and skipping a file that is no longer there is accurate. Any other
      // code means the entry is there but could not be examined, and dropping it would shorten the
      // list without saying so — a partial list the model reads as the whole one.
      const info = await fs.stat(join(directory, dirent.name)).catch((error: unknown) => {
        if (!isENOENT(error)) throw error
        return undefined
      })
      if (info === undefined) continue
      entries.push({
        name: dirent.name,
        kind: kind ?? kindForExtension(splitExtension(dirent.name).ext),
        public_path: publicPathFor(policy.urlPrefix, [scope.caseId, scope.userId, ...segments, dirent.name]),
        bytes: info.size,
        modified: info.mtime.toISOString(),
      })
    }
  }
  await collect(scope.directory, policy.groupByKind ? undefined : 'other', [])
  entries.sort((left, right) => right.modified.localeCompare(left.modified) || left.name.localeCompare(right.name))
  return { entries: entries.slice(0, limit), total: entries.length }
}

/**
 * Format a byte count for a model-visible result.
 * @param bytes - the size in bytes.
 * @returns a compact human-readable size.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const PUBLISH_DESCRIPTION =
  'Deliver a file you generated to the user, so they can open or download it. Files inside your '
  + 'sandbox are not reachable by the user: this tool copies the file into the case library that the '
  + 'web front end serves, and returns the path plus the delivery tag your reply must carry. Use it '
  + 'for every artifact the user should receive — reports, spreadsheets, HTML summaries, charts, '
  + 'data exports. The published copy is immutable: publishing again produces a new file, and the '
  + 'source stays in your workspace unless you pass move.'

const LIST_DESCRIPTION =
  'List the files you have already delivered to this user, newest first. Only your own published '
  + 'artifacts are listed; artifacts other subjects of the same case published are not visible here.'

/**
 * Register the artifact tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the deployment's artifact delivery configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const policy = resolvePolicy(config)

  ctx.tools.register(defineTool({
    name: 'artifact_publish',
    description: PUBLISH_DESCRIPTION,
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'The file to deliver, as this sandbox sees it — absolute, or relative to the working directory.',
      },
      title: {
        type: 'string',
        description: 'Title recorded in the delivered file name; defaults to the source file name.',
      },
      kind: {
        type: 'string',
        enum: [...ARTIFACT_KINDS],
        description: 'Delivery folder; inferred from the file extension when omitted.',
      },
      move: {
        type: 'boolean',
        description: 'Move the file instead of copying it. Defaults to false, which leaves the source readable.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: [...ARTIFACT_KINDS] },
          public_path: { type: 'string', required: true },
          url: { type: 'string' },
          attachment_tag: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          source_path: { type: 'string', required: true },
          moved: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const published = value as {
          name: string
          public_path: string
          url?: string
          attachment_tag: string
          bytes: number
          source_path: string
          moved: boolean
        }
        const lines = [
          `Delivered ${published.name} (${formatBytes(published.bytes)}) to the case library.`,
          `public_path: ${published.public_path}`,
        ]
        if (published.url !== undefined) lines.push(`url: ${published.url}`)
        lines.push('Append this line to your reply verbatim, as its own paragraph:', published.attachment_tag)
        if (!published.moved) lines.push(`The source is still at ${published.source_path}.`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const scope = currentCase(policy)
      const source = await resolveSource(scope, args.file_path, exec.agent?.session.header.cwd ?? '/workspace', policy.maxBytes)
      const { stem: rawStem, ext } = splitExtension(basename(source.host))
      const stem = sanitizeSegment(args.title ?? rawStem, 'artifact')
      const kind = args.kind ?? kindForExtension(ext)
      const directory = policy.groupByKind ? join(scope.directory, kind) : scope.directory
      await fs.mkdir(directory, { recursive: true })
      const stamp = formatStamp(new Date())
      const destination = await publishInto(directory, source, stamp, stem, ext)
      const moved = args.move === true
      if (moved) await fs.unlink(source.host)
      const prefix = policy.groupByKind ? [scope.caseId, scope.userId, kind] : [scope.caseId, scope.userId]
      const segments = [...prefix, basename(destination)]
      const publicPath = publicPathFor(policy.urlPrefix, segments)
      return {
        name: basename(destination),
        kind,
        public_path: publicPath,
        ...(policy.publicOrigin === undefined ? {} : { url: `${policy.publicOrigin}${publicPath}` }),
        attachment_tag: attachmentTag(publicPath),
        bytes: source.size,
        source_path: source.containerPath,
        moved,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Deliver artifact', kind: 'other', rawInput: args.file_path }),
  }))

  ctx.tools.register(defineTool({
    name: 'artifact_list',
    description: LIST_DESCRIPTION,
    parameters: {
      limit: {
        type: 'integer',
        description: 'Largest number of entries to return; defaults to 50.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                public_path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                modified: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const listed = value as { entries: readonly PublishedArtifact[]; total: number }
        if (listed.entries.length === 0) {
          return [{ type: 'text', text: 'Nothing has been delivered to this user yet.' }]
        }
        const lines = listed.entries.map(entry =>
          `- ${entry.public_path} (${entry.kind}, ${formatBytes(entry.bytes)}, ${entry.modified})`)
        const more = listed.total > listed.entries.length ? `
${listed.total - listed.entries.length} more not shown.` : ''
        return [{ type: 'text', text: `${listed.total} delivered file(s), newest first:\n${lines.join('\n')}${more}` }]
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
      return listPublished(currentCase(policy), policy, limit)
    },
    presentCall: args => ({ card: 'generic', title: 'List delivered artifacts', kind: 'other', rawInput: args.limit }),
  }))
}
