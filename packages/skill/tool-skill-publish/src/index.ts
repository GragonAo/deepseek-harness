/**
 * Model-facing skill publication: hand a skill the agent has just written, as
 * ordinary files, to the deployment's management plane, which records it and
 * installs it into the publisher's skill library.
 *
 * The skill document already exists in the session workspace, so passing that
 * directory is the whole request. This plugin walks the tree through `ctx.fs`,
 * validates the document with the seam-owned format reader, and submits the same
 * bytes as one `multipart/form-data` archive — the model never writes the skill's
 * content back into its own context to publish it.
 *
 * **This plugin never installs anything.** The management plane owns both the
 * record and the installation: it lists skills for its users, so a skill it does
 * not know about is one the user cannot see, enable, disable, or delete. A
 * publication therefore succeeds only when the platform accepted it, and a
 * deployment without a configured submission target refuses to load rather than
 * writing a skill the platform will not list.
 *
 * @module @deepseek-ai/dsh-tool-skill-publish
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { FsError, type FsTarget } from '@deepseek-ai/dsh-fs'
import { readSkillDocument, type SkillDocumentIssue } from '@deepseek-ai/dsh-skill'
import { requireUser } from '@deepseek-ai/dsh-tenant'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { zipSync } from 'fflate'

/** Cordis plugin name. */
export const name = 'tool-skill-publish'

/** Services required before a skill can be published from files. */
export const inject = ['fs', 'tools']

const DEFAULT_MAX_FILES = 512
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024
/**
 * Deadline for the submission. It carries far more than a round trip: the
 * platform stores the archive and installs it back through this host before it
 * answers, and a freshly started host's first outbound connection to it has been
 * measured past 10s — a deadline that short turns "slow" into "not published",
 * which the model would then report to the user as a real gap.
 */
const DEFAULT_RECORD_TIMEOUT_MS = 30_000
const SKILL_ENTRY = 'SKILL.md'
/** Directory entries every filesystem carries but no skill means to publish. */
const NOISE_ENTRIES = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store'])
/** Archive sidecar prefix: `._SKILL.md` is metadata, not content. */
const NOISE_PREFIX = '._'
/** Longest platform explanation carried into a result, in characters. */
const MAX_DETAIL = 300

/** Where a publication is filed: the management plane's ingestion endpoint. */
export interface RecordConfig {
  /** Absolute URL of the platform's host-publication ingestion endpoint. */
  url: string
  /** Shared token that endpoint requires, written into the configuration. */
  token?: string
  /**
   * Name of the environment variable holding the shared token. The alternative to
   * {@link RecordConfig.token} for deployments that deliver the token as a Secret;
   * the plugin reads it once at load, so a missing variable fails the load rather
   * than every publication.
   */
  tokenEnv?: string
  /** Request deadline in milliseconds. Defaults to 30000. */
  timeoutMs?: number
}

/** Skill publication configuration. */
export interface Config {
  /** Largest number of files one skill may hold. Defaults to 512. */
  maxFiles?: number
  /** Largest single file accepted, in bytes. Defaults to 1 MiB. */
  maxFileBytes?: number
  /** Largest total size of one skill, in bytes. Defaults to 16 MiB. */
  maxTotalBytes?: number
  /** The management plane that records and installs a publication. Required. */
  record: RecordConfig
}

/** Validate the publication bounds and the submission target as configuration. */
export const Config: Schema<Config> = z.object({
  maxFiles: z.number(),
  maxFileBytes: z.number(),
  maxTotalBytes: z.number(),
  // Required, unlike the bounds: a deployment with no target has nothing it may
  // install, so it fails to load rather than accepting publications it cannot file.
  record: z.object({
    url: z.string(),
    token: z.string(),
    tokenEnv: z.string(),
    timeoutMs: z.number(),
  }).required(),
})

/** Publication options resolved once at load, so no call re-derives a default. */
interface PublishSpec {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly record: ResolvedRecord
}

/** A submission target whose fields are validated. */
interface ResolvedRecord {
  readonly url: string
  readonly token: string
  readonly timeoutMs: number
}

/** One file of a skill, at the path it holds inside the submitted archive. */
interface SkillFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** What the platform made of a submission. */
interface SubmitOutcome {
  /** Skill name the platform filed it under, when it reported one. */
  readonly name?: string
  /** Platform record id, when it reported one. */
  readonly id?: string
  /** Whether the platform replaced a record of the same name. */
  readonly replaced: boolean
}

/**
 * Resolve the deployment's publication options, refusing a value that cannot be
 * honoured instead of silently substituting the default.
 * @param config - the deployment's configuration.
 * @returns the bounds and submission target every publication uses.
 */
function resolveSpec(config: Config): PublishSpec {
  return {
    maxFiles: positive('maxFiles', config.maxFiles, DEFAULT_MAX_FILES),
    maxFileBytes: positive('maxFileBytes', config.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    maxTotalBytes: positive('maxTotalBytes', config.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    record: resolveRecord(config.record),
  }
}

/**
 * Validate the submission target, refusing a half-configured one: a URL without
 * the token would be rejected by the endpoint on every publication, and a
 * silently skipped submission is worse than a refused load.
 * @param record - the deployment's submission configuration.
 * @returns the validated target.
 */
function resolveRecord(record: RecordConfig): ResolvedRecord {
  if (record.url.trim() === '') {
    throw new TypeError('tool-skill-publish record.url must be a non-empty URL, received an empty string')
  }
  return {
    url: record.url.trim(),
    token: resolveToken(record),
    timeoutMs: positive('record.timeoutMs', record.timeoutMs, DEFAULT_RECORD_TIMEOUT_MS),
  }
}

/**
 * Resolve the token the endpoint expects, from the configuration or from the
 * environment variable it names.
 *
 * The environment path exists so a deployment can hand the token over as a
 * Secret: the tenant configuration on this stack is a mounted file, and a token
 * written there is readable by anything that can read that object.
 * @param record - the deployment's submission configuration.
 * @returns the token to send.
 */
function resolveToken(record: RecordConfig): string {
  const literal = record.token?.trim() ?? ''
  const name = record.tokenEnv?.trim() ?? ''
  if (literal !== '' && name !== '') {
    throw new TypeError('tool-skill-publish record sets both token and tokenEnv; they are alternatives, set one')
  }
  if (literal !== '') return literal
  if (name === '') {
    throw new TypeError('tool-skill-publish record needs a token: set record.token or record.tokenEnv')
  }
  const fromEnvironment = process.env[name]?.trim() ?? ''
  if (fromEnvironment === '') {
    throw new TypeError(`tool-skill-publish record.tokenEnv names ${name}, which is unset or empty in this environment`)
  }
  return fromEnvironment
}

/**
 * Validate one configured bound.
 * @param field - configuration field name, for the failure message.
 * @param value - configured value, when the deployment set one.
 * @param fallback - documented default.
 * @returns the validated bound.
 */
function positive(field: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`tool-skill-publish ${field} must be a positive integer, received ${value}`)
  }
  return value
}

/**
 * Whether one directory entry is packaging noise rather than skill content.
 * @param entry - directory entry name.
 * @returns whether the walk skips it.
 */
function noise(entry: string): boolean {
  return NOISE_ENTRIES.has(entry) || entry.startsWith(NOISE_PREFIX)
}

/**
 * The account a publication is filed under. A publication is a claim on one
 * person's library, so a call outside an authenticated request has no subject and
 * nothing it could honestly submit.
 * @returns the calling subject.
 * @throws Error when the call runs with no user in scope.
 */
function callerSubject(): string {
  try {
    return String(requireUser())
  } catch {
    // Only the missing-subject error is swallowed; it is the one condition this
    // refusal names, and it is the only way the accessor fails.
    throw new Error('This session has no account, so nothing can be filed in a skill library. Publishing needs an authenticated request.')
  }
}

/**
 * Read one skill directory into the files a publication submits, applying the
 * configured bounds while the files are read.
 * @param ctx - context carrying the filesystem seam.
 * @param path - directory the model named, relative to the session cwd or absolute.
 * @param exec - the calling tool execution, supplying the session cwd and cancellation.
 * @param spec - resolved publication bounds.
 * @returns the skill's files with `/`-separated archive paths, sorted by path.
 * @throws Error when the directory is missing, is not a directory, holds a non-regular entry, or exceeds a bound.
 */
async function collectFiles(
  ctx: Context,
  path: string,
  exec: ToolRunContext,
  spec: PublishSpec,
): Promise<SkillFile[]> {
  const cwd = exec.agent?.session.header.cwd
  const root = await ctx.fs.resolve(path, { ...cwd !== undefined ? { cwd } : {}, signal: exec.signal })
  const info = await ctx.fs.stat(root, exec.signal)
  if (info === undefined) {
    throw new Error(`There is nothing at ${path}. Write the skill's files first, then publish the directory holding ${SKILL_ENTRY}.`)
  }
  if (info.type !== 'directory') {
    throw new Error(`${path} is not a directory. Publish the directory that holds ${SKILL_ENTRY}, not the file itself.`)
  }
  const files: SkillFile[] = []
  const pending: { target: FsTarget; prefix: string }[] = [{ target: root, prefix: '' }]
  let total = 0
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    for (const entry of await ctx.fs.listDir(next.target, exec.signal)) {
      if (noise(entry.name)) continue
      const entryPath = next.prefix === '' ? entry.name : `${next.prefix}/${entry.name}`
      if (entry.type === 'directory') {
        pending.push({ target: entry.target, prefix: entryPath })
        continue
      }
      if (entry.type !== 'file') {
        throw new Error(`${entryPath} is not a regular file. Publish plain files only.`)
      }
      if (files.length + 1 > spec.maxFiles) {
        throw new Error(`The skill holds more than ${spec.maxFiles} files. Publish fewer files, or raise maxFiles for this deployment.`)
      }
      if (entry.size !== undefined && entry.size > spec.maxFileBytes) tooLarge(entryPath, spec)
      let bytes: Uint8Array
      try {
        bytes = await ctx.fs.readBytes(entry.target, exec.signal, spec.maxFileBytes)
      } catch (error) {
        // A file that grew past the bound after the listing reports it this way;
        // any other failure says nothing about the skill's size.
        if (!(error instanceof FsError) || error.code !== 'FS_TOO_LARGE') throw error
        tooLarge(entryPath, spec)
      }
      total += bytes.byteLength
      if (total > spec.maxTotalBytes) {
        throw new Error(`The skill is larger than ${spec.maxTotalBytes} bytes. Publish a smaller skill, or raise maxTotalBytes for this deployment.`)
      }
      files.push({ path: entryPath, bytes })
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Refuse one file that is past the per-file bound.
 * @param path - the file's path inside the archive.
 * @param spec - resolved publication bounds.
 * @throws Error naming the file and the bound.
 */
function tooLarge(path: string, spec: PublishSpec): never {
  throw new Error(`${path} is larger than ${spec.maxFileBytes} bytes. Publish a smaller file, or raise maxFileBytes for this deployment.`)
}

/**
 * Check that the collected files form one loadable skill document, so the model
 * hears about a malformed document now instead of as a platform rejection.
 * @param files - the skill's files.
 * @returns the skill's name and description, as its document declares them.
 * @throws Error when `SKILL.md` is absent from the archive root or cannot be read as a skill.
 */
function readSkill(files: readonly SkillFile[]): { name: string; description: string } {
  const entry = files.find(file => file.path === SKILL_ENTRY)
  if (entry === undefined) {
    const found = files.map(file => file.path)
    throw new Error(`That directory holds no ${SKILL_ENTRY} at its root, and a skill has exactly one. Files found: ${found.length === 0 ? '(none)' : found.join(', ')}.`)
  }
  const document = readSkillDocument(new TextDecoder().decode(entry.bytes))
  if (!document.ok) {
    throw new Error(`${SKILL_ENTRY} cannot be loaded as a skill: ${document.issues.map(describeIssue).join('; ')}. Fix that and publish again.`)
  }
  return { name: document.document.name, description: document.document.description }
}

/**
 * Render one document-format issue as the line and rule it violates.
 * @param issue - the reader's coded issue.
 * @returns the model-facing description.
 */
function describeIssue(issue: SkillDocumentIssue): string {
  /* v8 ignore next -- the format reader always carries a line; the field stays optional for readers that cannot place one. */
  const where = issue.line === undefined ? '' : ` (line ${issue.line})`
  return `${issue.code}${where}: ${issue.message}`
}

/**
 * Read the platform's answer as text without letting a broken stream fail the
 * publication.
 * @param response - the platform's response.
 * @returns the trimmed body, empty when it could not be read.
 */
async function responseDetail(response: Response): Promise<string> {
  /* v8 ignore next -- a body cut off mid-read rejects; the status or the missing verdict explains the outcome anyway. */
  return (await response.text().catch(() => '')).trim()
}

/**
 * Bound a platform explanation to what a result can carry.
 * @param detail - the platform's own text.
 * @returns the text, elided when it is longer than {@link MAX_DETAIL}.
 */
function elide(detail: string): string {
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail
}

/**
 * Decide what a 2xx answer means.
 *
 * A platform that answers every request with its own envelope — this deployment's
 * does, returning HTTP 200 with `{ success: false, message }` for a refusal —
 * reports failure in the body, not the status. Treating such a 200 as success
 * would tell the user the skill is in their library while it is not. A body that
 * is not JSON proves nothing, so the status stands.
 * @param detail - the response body.
 * @returns the submitted record, or the platform's refusal reason.
 */
function verdictIn(detail: string): { accepted: true; outcome: SubmitOutcome } | { accepted: false; reason: string } {
  const refused = (): { accepted: false; reason: string } => ({ accepted: false, reason: 'the platform refused the record' })
  if (!detail.startsWith('{')) return { accepted: true, outcome: { replaced: false } }
  type Envelope = {
    success?: unknown
    message?: unknown
    result?: { ok?: unknown; id?: unknown; name?: unknown; replacedRows?: unknown } | null
  }
  let envelope: Envelope
  try {
    envelope = JSON.parse(detail) as Envelope
  } catch {
    // A truncated body says nothing reliable about the outcome, so the status stands.
    return { accepted: true, outcome: { replaced: false } }
  }
  const message = typeof envelope.message === 'string' ? envelope.message.trim() : ''
  if (envelope.success === false || envelope.result?.ok === false) {
    return message === '' ? refused() : { accepted: false, reason: elide(message) }
  }
  const result = envelope.result ?? {}
  return {
    accepted: true,
    outcome: {
      ...typeof result.name === 'string' && result.name.trim() !== '' ? { name: result.name.trim() } : {},
      ...typeof result.id === 'string' && result.id.trim() !== '' ? { id: result.id.trim() } : {},
      replaced: typeof result.replacedRows === 'number' && result.replacedRows > 0,
    },
  }
}

/**
 * Submit one publication to the management plane: zip the files the walk already
 * holds and POST them, as bytes, with the publishing account.
 *
 * The archive is built here rather than requested from the model — the point of
 * publishing from a directory is that the skill never re-enters the conversation,
 * and that holds for the platform hop too.
 * @param record - validated submission target.
 * @param subject - the account the skill is filed under.
 * @param name - skill name, used as the archive's file name.
 * @param files - the skill's files.
 * @param signal - cancels the request.
 * @returns the submitted record as the platform reports it.
 * @throws Error when the platform refuses the publication or cannot be reached.
 */
async function submit(
  record: ResolvedRecord,
  subject: string,
  name: string,
  files: readonly SkillFile[],
  signal: AbortSignal,
): Promise<SubmitOutcome> {
  const archive = zipSync(Object.fromEntries(files.map(file => [file.path, file.bytes])))
  const body = new FormData()
  body.set('subject', subject)
  body.set('origin', 'dsh-skill-publish')
  body.set('file', new Blob([archive], { type: 'application/zip' }), `${name}.zip`)
  let response: Response
  let detail: string
  try {
    response = await fetch(record.url, {
      method: 'POST',
      body,
      headers: { 'x-dsh-ingest-token': record.token },
      signal: AbortSignal.any([signal, AbortSignal.timeout(record.timeoutMs)]),
    })
    detail = await responseDetail(response)
  } catch (error) {
    /* v8 ignore next -- fetch rejects with an Error (or a DOMException for an aborted request), never with a bare value. */
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`The skill library could not be reached: ${reason}. Nothing was published — this deployment installs skills only through its platform, so this call did not land.`)
  }
  const suffix = detail === '' ? '' : `: ${elide(detail)}`
  if (!response.ok) {
    throw new Error(`The skill library answered HTTP ${response.status}${suffix}. Nothing was published.`)
  }
  const verdict = verdictIn(detail)
  if (!verdict.accepted) {
    throw new Error(`The skill library refused the publication: ${verdict.reason}. Nothing was published — fix that and publish again.`)
  }
  return verdict.outcome
}

/**
 * Register the `skill_publish` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the filesystem and tool seams.
 * @param config - deployment's publication bounds and submission target.
 */
export function apply(ctx: Context, config: Config = { record: { url: '' } }): void {
  const spec = resolveSpec(config)
  ctx.tools.register(defineTool({
    name: 'skill_publish',
    description: [
      'Publish a skill you have finished writing as a directory, so it enters the user\'s skill library and later sessions can load it.',
      `The directory must hold ${SKILL_ENTRY} at its root; every other file in it is published with the skill.`,
      'Write the files first, then call this with the directory. Do not paste, quote, or archive the content.',
      'Publishing a skill whose name is already in the library replaces that earlier one.',
    ].join(' '),
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: `Directory holding ${SKILL_ENTRY}, relative to the session working directory or absolute.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true, description: 'Skill name the platform filed it under.' },
          fileCount: { type: 'integer', required: true, description: 'Number of files published.' },
          replaced: { type: 'boolean', required: true, description: 'Whether an earlier skill of the same name was replaced.' },
          id: { type: 'string', description: 'Platform record id, when the platform reported one.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Published the skill "${value.name}" (${value.fileCount} files) to the skill library: the platform recorded it and installed it${value.replaced ? ', replacing an earlier skill of the same name' : ''}, so the catalog lists it now and a later request can trigger it.`,
      }],
    },
    execute: async (args, exec) => {
      const subject = callerSubject()
      const files = await collectFiles(ctx, args.path, exec, spec)
      const skill = readSkill(files)
      const outcome = await submit(spec.record, subject, skill.name, files, exec.signal)
      return {
        name: outcome.name ?? skill.name,
        fileCount: files.length,
        replaced: outcome.replaced,
        ...outcome.id === undefined ? {} : { id: outcome.id },
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Publish skill from ${args.path}`,
      kind: 'other',
      locations: [{ path: args.path }],
    }),
  }))
}
