/**
 * Boots the real publication stack — the tool registry, the local filesystem
 * backend, and the ambient user the tool files a skill under — then drives the
 * registered `skill_publish` tool through `ctx.tools.execute` against a stand-in
 * management plane. The platform's own installation is not reachable from a unit
 * test, so what these cases pin is this side of the hop: the bytes submitted, the
 * refusal reporting, and the fact that nothing is installed locally.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FsError, type FsDirEntry, type FsInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import { runWithUser, UserId } from '@deepseek-ai/dsh-tenant'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as tool from '../src/index.ts'

const SIGNAL = new AbortController().signal
const USER = 'cs'
const TOKEN = 'ingest-secret'

/** One skill document the format reader accepts. */
function document(name = 'skill-guide', description = 'A written skill.'): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', 'Do the described thing.', ''].join('\n')
}

interface Stack {
  /** Context holding every mounted plugin. */
  readonly ctx: Context
  /** Scratch root the stack owns. */
  readonly root: string
  /** Session workspace the model writes the skill into. */
  readonly workspace: string
  /** Platform URL the tool publishes to. */
  readonly url: string
}

const CLEANUPS: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of CLEANUPS.splice(0)) await cleanup()
})

/** What a stand-in ingestion endpoint captured from one publication request. */
interface Captured {
  headers?: Record<string, string | string[] | undefined>
  body?: Buffer
}

/** The answer the stand-in ingestion endpoint gives. */
interface Answer {
  /** HTTP status to answer with. Defaults to 200. */
  readonly status?: number
  /** Response body. Defaults to the platform's success envelope. */
  readonly body?: string
  /** Accept the request and never answer, so the deadline is what ends the call. */
  readonly silent?: boolean
}

/**
 * Stand up a one-shot HTTP endpoint that behaves like the platform's ingestion
 * endpoint, and record the scratch state this test file has to tear down.
 * @param answer - status, body, or silence.
 * @param captured - receives the request headers and body.
 * @returns the endpoint's base URL and the server it runs on.
 */
async function platform(answer: Answer = {}, captured?: Captured): Promise<{ url: string; server: Server }> {
  const status = answer.status ?? 200
  const body = answer.body ?? '{"success":true,"result":{"ok":true,"name":"skill-guide","id":"11","replacedRows":0}}'
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (captured !== undefined) {
        captured.headers = request.headers
        captured.body = Buffer.concat(chunks)
      }
      if (answer.silent === true) return
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a bound port')
  CLEANUPS.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    })
  })
  return { url: `http://127.0.0.1:${address.port}/dsh/inner/skill/ingest`, server }
}

/**
 * Boot the real publication stack over one scratch tree.
 * @param overrides - deployment options; `record` defaults to a stand-in platform.
 * @returns the mounted context and the directories a test inspects.
 */
async function boot(overrides: Partial<Omit<tool.Config, 'record'>> & { record?: Partial<tool.RecordConfig> } = {}): Promise<Stack> {
  const url = overrides.record?.url ?? (await platform()).url
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-skill-publish-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem)
  // The stand-in token is the default only for a target that names no token source
  // of its own, so a test can hand the plugin a `tokenEnv` target instead.
  const record = overrides.record !== undefined && (overrides.record.token !== undefined || overrides.record.tokenEnv !== undefined)
    ? { ...overrides.record, url }
    : { token: TOKEN, ...overrides.record, url }
  await ctx.plugin(tool, { ...overrides, record })
  CLEANUPS.push(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, root, workspace, url }
}

/**
 * Boot the publication stack over a filesystem stand-in instead of the real one.
 * @param entries - what the stand-in lists for the skill directory.
 * @param read - how the stand-in answers a read.
 * @returns the mounted context and the directories a test inspects.
 */
async function bootScenario(entries: readonly FsDirEntry[], read: ReadMode): Promise<Stack> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-skill-publish-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(scenarioFs(entries, read))
  await ctx.plugin(tool, { record: { url: 'http://127.0.0.1:1/dsh/inner/skill/ingest', token: TOKEN } })
  CLEANUPS.push(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, root, workspace, url: 'http://127.0.0.1:1/dsh/inner/skill/ingest' }
}

/**
 * Write one skill directory the way an agent leaves it before publishing.
 * @param directory - absolute directory to fill.
 * @param files - path-to-content map, relative to the directory.
 * @returns the directory, for call chaining.
 */
async function writeSkill(directory: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return directory
}

interface CallOptions {
  /** Session working directory; absent means a caller with no session cwd. */
  readonly cwd?: string
}

let calls = 0

/**
 * Execute the `skill_publish` tool with one argument object.
 * @param stack - mounted stack to execute against.
 * @param args - tool arguments.
 * @param options - session cwd, when the call has one.
 * @returns the tool's registered result.
 */
async function publishTool(stack: Stack, args: Record<string, unknown>, options: CallOptions = {}) {
  const agent = options.cwd === undefined ? undefined : agentWithCwd(options.cwd)
  return await stack.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(`call-${++calls}`),
    name: 'skill_publish',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/**
 * Build a parent agent backed by a real session whose header carries the cwd.
 * @param cwd - absolute session working directory.
 * @returns the agent stand-in the tool reads `session.header.cwd` from.
 */
function agentWithCwd(cwd: string): Agent {
  const id = SessionId('publisher')
  const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd })
  return { id, session } as unknown as Agent
}

/**
 * Join the text blocks of one tool result.
 * @param result - the tool result.
 * @returns its model-facing text.
 */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Run one publication inside the authenticated user scope a tenant host sets. */
async function asUser<T>(run: () => Promise<T>): Promise<T> {
  return await runWithUser(UserId(USER), run)
}

/**
 * Recover the submitted archive from a captured multipart body.
 * @param captured - the request the stand-in platform received.
 * @returns the archive's files, keyed by their path inside the zip.
 */
function archiveOf(captured: Captured): Record<string, Uint8Array> {
  const body = captured.body
  if (body === undefined) throw new Error('the platform received no body')
  const contentType = String(captured.headers?.['content-type'] ?? '')
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  if (boundary === undefined) throw new Error(`the request carried no multipart boundary: ${contentType}`)
  const start = body.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`))
  return unzipSync(body.subarray(start, end))
}

/**
 * Read one text field out of a captured multipart body.
 * @param captured - the request the stand-in platform received.
 * @param field - form field name.
 * @returns the field's value.
 */
function fieldOf(captured: Captured, field: string): string | undefined {
  const text = captured.body?.toString('utf8') ?? ''
  return new RegExp(`name="${field}"\\r\\n\\r\\n(.*?)\\r\\n`, 's').exec(text)?.[1]
}

/** What a stand-in `readBytes` does when the walk reads a file. */
type ReadMode = 'ok' | 'too-large' | 'io-error' | 'plain-error'

/**
 * A filesystem stand-in for the states a real one cannot produce on every
 * platform: a directory entry that is not a regular file, and a read that fails
 * past the listing (a file growing after it was listed).
 * @param entries - what `listDir` reports.
 * @param read - how `readBytes` answers.
 * @param bytes - the bytes an `ok` read returns.
 * @returns a plugin that provides the `fs` service.
 */
function scenarioFs(entries: readonly FsDirEntry[], read: ReadMode, bytes = new TextEncoder().encode(document())) {
  return class extends Service {
    /**
     * Register the stand-in filesystem.
     * @param ctx - registrant context.
     */
    constructor(ctx: Context) {
      super(ctx, 'fs')
    }

    /**
     * Resolve a requested path as-is.
     * @param path - the requested path.
     * @returns the same string as an opaque target.
     */
    resolve(path: string): Promise<FsTarget> {
      return Promise.resolve(path as unknown as FsTarget)
    }

    /**
     * Report a directory, which is what the walk expects of a skill's root.
     * @returns the directory's metadata.
     */
    stat(): Promise<FsInfo> {
      return Promise.resolve({ version: 'v1' as FsInfo['version'], type: 'directory' })
    }

    /**
     * Report the scenario's entries.
     * @returns one listing of the skill directory.
     */
    listDir(): Promise<FsDirEntry[]> {
      return Promise.resolve([...entries])
    }

    /**
     * Answer the scenario's read.
     * @returns the file's bytes.
     * @throws FsError when the scenario is a failing read.
     */
    readBytes(): Promise<Uint8Array> {
      switch (read) {
        case 'ok': return Promise.resolve(bytes)
        case 'too-large': return Promise.reject(new FsError('the file grew past the bound', 'FS_TOO_LARGE'))
        case 'io-error': return Promise.reject(new FsError('the file became unreadable', 'FS_IO_ERROR'))
        case 'plain-error': return Promise.reject(new Error('the disk fell over'))
      }
    }
  }
}

describe('skill_publish', () => {
  it('submits a skill the agent wrote, skipping packaging noise, and reports what the platform filed', async () => {
    const captured: Captured = {}
    const server = await platform({}, captured)
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), {
      'SKILL.md': document(),
      'references/checklist.md': 'check',
      '.git/config': 'noise',
      'node_modules/left-pad/index.js': 'noise',
      '._SKILL.md': 'noise',
      '.DS_Store': 'noise',
      '__MACOSX/x': 'noise',
    })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill_publish success')
    expect(result.value).toEqual({ name: 'skill-guide', fileCount: 2, replaced: false, id: '11' })
    expect(textOf(result)).toBe(
      'Published the skill "skill-guide" (2 files) to the skill library: the platform recorded it and installed it, '
      + 'so the catalog lists it now and a later request can trigger it.',
    )

    expect(captured.headers?.['x-dsh-ingest-token']).toBe(TOKEN)
    expect(fieldOf(captured, 'subject')).toBe(USER)
    expect(fieldOf(captured, 'origin')).toBe('dsh-skill-publish')
    const archive = archiveOf(captured)
    expect(Object.keys(archive).sort()).toEqual(['SKILL.md', 'references/checklist.md'])
    expect(new TextDecoder().decode(archive['SKILL.md'])).toBe(document())
  })

  it('reports a replacement when the platform replaced an earlier skill of the same name', async () => {
    const server = await platform({
      body: '{"success":true,"result":{"ok":true,"name":"skill-guide","id":"12","replacedRows":1}}',
    })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    if (result.isError) throw new Error('expected skill_publish success')
    expect(result.value).toEqual({ name: 'skill-guide', fileCount: 1, replaced: true, id: '12' })
    expect(textOf(result)).toContain('replacing an earlier skill of the same name')
  })

  it('publishes an absolute directory with no session cwd, and keeps nesting', async () => {
    const captured: Captured = {}
    const server = await platform({}, captured)
    const stack = await boot({ record: { url: server.url } })
    const directory = await writeSkill(join(stack.workspace, 'skill-guide'), {
      'SKILL.md': document(),
      'docs/deep/note.md': 'nested',
    })

    const result = await asUser(async () => await publishTool(stack, { path: directory }))

    if (result.isError) throw new Error('expected skill_publish success')
    expect(Object.keys(archiveOf(captured)).sort()).toEqual(['SKILL.md', 'docs/deep/note.md'])
  })

  it('keeps the fallback name when the platform answers without one', async () => {
    const server = await platform({ body: '{"success":true}' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    if (result.isError) throw new Error('expected skill_publish success')
    expect(result.value).toEqual({ name: 'skill-guide', fileCount: 1, replaced: false })
  })

  it('renders the publication card from the requested path', async () => {
    const stack = await boot()

    expect(stack.ctx.tools.get('skill_publish')?.presentCall?.({ path: 'skill-guide' })).toEqual({
      card: 'generic',
      title: 'Publish skill from skill-guide',
      kind: 'other',
      locations: [{ path: 'skill-guide' }],
    })
  })

  it('refuses a path with nothing at it', async () => {
    const stack = await boot()

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'absent' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('There is nothing at absent.')
  })

  it('refuses a path that is a file rather than a directory', async () => {
    const stack = await boot()
    await writeFile(join(stack.workspace, 'SKILL.md'), document())

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'SKILL.md' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('SKILL.md is not a directory.')
  })

  it('refuses a directory holding an entry that is not a regular file', async () => {
    const stack = await bootScenario(
      [{ name: 'target.md', type: 'other', target: 'target' as unknown as FsTarget }],
      'ok',
    )

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('target.md is not a regular file.')
  })

  it('names the file when the read finds it past the per-file bound', async () => {
    const stack = await bootScenario([{ name: 'SKILL.md', type: 'file', target: 'entry' as unknown as FsTarget }], 'too-large')

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('SKILL.md is larger than 1048576 bytes.')
  })

  it('passes an unreadable file through, since the failure is not about size', async () => {
    const stack = await bootScenario([{ name: 'SKILL.md', type: 'file', target: 'entry' as unknown as FsTarget }], 'io-error')

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('the file became unreadable')
  })

  it('passes a provider failure that is not a filesystem error through unchanged', async () => {
    const stack = await bootScenario([{ name: 'SKILL.md', type: 'file', target: 'entry' as unknown as FsTarget }], 'plain-error')

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('the disk fell over')
  })

  it('refuses a directory whose root holds no SKILL.md, naming what it found', async () => {
    const stack = await boot()
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'docs/guide.md': 'no document' })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('That directory holds no SKILL.md at its root')
    expect(textOf(result)).toContain('Files found: docs/guide.md.')
  })

  it('names an empty directory as holding no files at all', async () => {
    const stack = await boot()
    await writeSkill(join(stack.workspace, 'skill-guide'), { '.git/config': 'noise' })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Files found: (none).')
  })

  it('refuses a SKILL.md the format reader cannot load', async () => {
    const stack = await boot()
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': '# no frontmatter at all\n' })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('SKILL.md cannot be loaded as a skill: frontmatter-missing')
  })

  it('refuses a document whose name is not kebab-case, naming the rule and the line', async () => {
    const stack = await boot()
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document('Skill Guide') })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/SKILL\.md cannot be loaded as a skill: [\w-]+ \(line \d+\): /u)
  })

  it('refuses more files than the deployment allows', async () => {
    const stack = await boot({ maxFiles: 1 })
    await writeSkill(join(stack.workspace, 'skill-guide'), {
      'SKILL.md': document(),
      'extra.md': 'second file',
    })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill holds more than 1 files.')
  })

  it('refuses a skill larger than the deployment allows', async () => {
    const stack = await boot({ maxTotalBytes: 10 })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill is larger than 10 bytes.')
  })

  it('names the file that exceeds the per-file bound', async () => {
    const stack = await boot({ maxFileBytes: 128 })
    await writeSkill(join(stack.workspace, 'skill-guide'), {
      'SKILL.md': document(),
      'references/long.md': 'x'.repeat(256),
    })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('references/long.md is larger than 128 bytes.')
  })

  it('passes a filesystem failure that is not the size bound through unchanged', async () => {
    const stack = await boot()
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })
    const aborted = new AbortController()
    aborted.abort()

    const result = await stack.ctx.tools.execute({
      signal: aborted.signal,
      callId: CallId(`call-${++calls}`),
      name: 'skill_publish',
      arguments: { path: 'skill-guide' },
      agent: agentWithCwd(stack.workspace),
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('is larger than')
  })

  it('refuses to publish with no account in scope', async () => {
    const stack = await boot()
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('This session has no account')
  })

  it('reports the platform refusing the record, in the platform\'s own words', async () => {
    const server = await platform({ body: '{"success":false,"message":"技能名已被占用"}' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill library refused the publication: 技能名已被占用.')
    expect(textOf(result)).toContain('Nothing was published')
  })

  it('reports a refusal envelope that carried no reason', async () => {
    const server = await platform({ body: '{"success":false}' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('the platform refused the record')
  })

  it('reports a refusal carried in the result instead of the envelope', async () => {
    const server = await platform({ body: '{"success":true,"result":{"ok":false},"message":"包不合法"}' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill library refused the publication: 包不合法.')
  })

  it('elides a platform explanation longer than a result can carry', async () => {
    const server = await platform({ body: JSON.stringify({ success: false, message: 'x'.repeat(400) }) })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`${'x'.repeat(300)}…`)
    expect(textOf(result)).not.toContain('x'.repeat(301))
  })

  it('reports an HTTP failure with the status and the body', async () => {
    const server = await platform({ status: 500, body: 'ingest exploded' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill library answered HTTP 500: ingest exploded.')
  })

  it('reports an HTTP failure with no body', async () => {
    const server = await platform({ status: 502, body: '' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill library answered HTTP 502.')
  })

  it('treats a 2xx body that is not JSON as accepted, since the status is what it can prove', async () => {
    const server = await platform({ body: 'plain acknowledgement' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    if (result.isError) throw new Error('expected skill_publish success')
    expect(result.value).toEqual({ name: 'skill-guide', fileCount: 1, replaced: false })
  })

  it('treats a truncated JSON body as accepted, since it proves nothing about the outcome', async () => {
    const server = await platform({ body: '{"success":tru' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    if (result.isError) throw new Error('expected skill_publish success')
    expect(result.value).toEqual({ name: 'skill-guide', fileCount: 1, replaced: false })
  })

  it('treats a null result as accepted, without an id to report', async () => {
    const server = await platform({ body: '{"success":true,"result":null}' })
    const stack = await boot({ record: { url: server.url } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    if (result.isError) throw new Error('expected skill_publish success')
    expect(result.value).toEqual({ name: 'skill-guide', fileCount: 1, replaced: false })
  })

  it('reports an unreachable platform', async () => {
    const stack = await boot({ record: { url: 'http://127.0.0.1:1/dsh/inner/skill/ingest' } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill library could not be reached')
    expect(textOf(result)).toContain('Nothing was published')
  })

  it('reports a platform that answers nothing before the deadline', async () => {
    const server = await platform({ silent: true })
    const stack = await boot({ record: { url: server.url, timeoutMs: 50 } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The skill library could not be reached')
  })
})

describe('configuration', () => {
  /**
   * Mount the plugin as a deployment would, with one scratch context.
   * @param config - the plugin configuration to mount.
   * @returns the mounted context.
   */
  async function mount(config: Record<string, unknown>): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem)
    CLEANUPS.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(tool, config as unknown as tool.Config)
    return ctx
  }

  /**
   * Mount one refused configuration and report why it was refused.
   * @param config - the plugin configuration to mount.
   * @returns the refusal message.
   */
  async function refusal(config: Record<string, unknown>): Promise<string> {
    try {
      await mount(config)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('expected the plugin to refuse this configuration')
  }

  it('refuses to load with no submission target at all', async () => {
    expect(await refusal({})).toMatch(/record/u)
  })

  it('refuses an empty endpoint URL', async () => {
    expect(await refusal({ record: { url: ' ', token: TOKEN } })).toContain('record.url must be a non-empty URL')
  })

  it('refuses a target that sets both token and tokenEnv', async () => {
    expect(await refusal({ record: { url: 'http://127.0.0.1:1/x', token: TOKEN, tokenEnv: 'DSH_INGEST_TOKEN' } }))
      .toContain('record sets both token and tokenEnv')
  })

  it('refuses a target with no token', async () => {
    expect(await refusal({ record: { url: 'http://127.0.0.1:1/x' } })).toContain('needs a token')
  })

  it('refuses a tokenEnv naming a variable that is unset', async () => {
    expect(await refusal({ record: { url: 'http://127.0.0.1:1/x', tokenEnv: 'DSH_INGEST_TOKEN_UNSET' } }))
      .toContain('which is unset or empty in this environment')
  })

  it('reads the token from the environment variable the deployment names', async () => {
    process.env.DSH_INGEST_TOKEN_TEST = 'from-environment'
    CLEANUPS.push(async () => { delete process.env.DSH_INGEST_TOKEN_TEST })
    const captured: Captured = {}
    const server = await platform({}, captured)
    const stack = await boot({ record: { url: server.url, tokenEnv: 'DSH_INGEST_TOKEN_TEST' } })
    await writeSkill(join(stack.workspace, 'skill-guide'), { 'SKILL.md': document() })

    const result = await asUser(async () =>
      await publishTool(stack, { path: 'skill-guide' }, { cwd: stack.workspace }))

    if (result.isError) throw new Error('expected skill_publish success')
    expect(captured.headers?.['x-dsh-ingest-token']).toBe('from-environment')
  })

  it('refuses a bound that is not a positive integer', async () => {
    for (const [field, value] of [['maxFiles', 0], ['maxFileBytes', -1], ['maxTotalBytes', 1.5]] as const) {
      expect(await refusal({ record: { url: 'http://127.0.0.1:1/x', token: TOKEN }, [field]: value }))
        .toContain(`tool-skill-publish ${field} must be a positive integer`)
    }
  })

  it('refuses a deadline that is not a positive integer', async () => {
    expect(await refusal({ record: { url: 'http://127.0.0.1:1/x', token: TOKEN, timeoutMs: 0 } }))
      .toContain('tool-skill-publish record.timeoutMs must be a positive integer')
  })
})
