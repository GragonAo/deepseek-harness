import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import * as SessionUploads from '../src/index.ts'
import { CONTEXT_NAME } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A session whose cwd is a fresh temporary workspace. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-uploads-'))
  roots.push(root)
  return root
}

async function harness(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  return ctx
}

/** A registered agent over a real session, with only the fields the listener reads. */
function stubAgent(ctx: Context, id: string, cwd?: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: cwd === undefined ? {} : { cwd } })
  const agent = {
    id: session.id,
    options: {},
    session,
    status: 'idle',
    acceptsNextStep: false,
    ctx,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

/** The runtime-context text one assembly contributes, or `''` when it contributes none. */
async function runtimeContext(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(signal === undefined ? { agent } : { agent, signal })
  return renderContextSections(assembly).map(section => section.text).join('\n')
}

describe('session uploads inventory', () => {
  it('tells the model which files the user uploaded and where they are', async () => {
    const root = await workspace()
    const uploads = join(root, 'uploads')
    await mkdir(uploads)
    await writeFile(join(uploads, '供述材料.pdf'), 'x'.repeat(2048))
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-1', root)

    const text = await runtimeContext(ctx, agent)

    expect(text).toContain('Files the user attached to this session:')
    expect(text).toContain('供述材料.pdf — 2 KB')
    expect(text).toContain('read_image reads an image')
  })

  it('contributes nothing when the session has no uploads directory', async () => {
    const root = await workspace()
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-2', root)

    expect(await runtimeContext(ctx, agent)).toBe('')
  })

  it('contributes nothing when the configured name is a file or an assembly has no session', async () => {
    const root = await workspace()
    await writeFile(join(root, 'uploads'), 'not a directory')
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-3', root)

    expect(await runtimeContext(ctx, agent)).toBe('')
    // A scope-only assembly (a cold read, a diagnostic) has no session directory.
    expect(renderContextSections(await ctx.systemPrompt.assemble({}))).toEqual([])
  })

  it('lists the directory the deployment names, up to the configured count', async () => {
    const root = await workspace()
    await mkdir(join(root, 'attachments'))
    await writeFile(join(root, 'attachments', 'a.txt'), 'a')
    await writeFile(join(root, 'attachments', 'b.txt'), 'b')
    await writeFile(join(root, 'attachments', 'c.txt'), 'c')
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, { directory: 'attachments', maxEntries: 1 })
    const agent = stubAgent(ctx, 'session-4', root)

    const text = await runtimeContext(ctx, agent)

    expect(text).toContain('attachments/a.txt')
    expect(text).not.toContain('attachments/b.txt')
    expect(text).toContain('2 more entries are not listed.')
  })

  it('resolves the directory without a session cwd', async () => {
    const root = await workspace()
    await mkdir(join(root, 'uploads'))
    await writeFile(join(root, 'uploads', 'note.txt'), 'n')
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-5')

    expect(await runtimeContext(ctx, agent)).toContain('uploads/note.txt')
  })

  it('reads the session directory the filesystem provider serves after a file arrives', async () => {
    const root = await workspace()
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-6', root)
    expect(await runtimeContext(ctx, agent)).toBe('')

    await mkdir(join(root, 'uploads'))
    await writeFile(join(root, 'uploads', 'late.pdf'), 'pdf')

    // The inventory is a snapshot of the directory now, not of the first turn.
    expect(await runtimeContext(ctx, agent, new AbortController().signal)).toContain('uploads/late.pdf')
  })

  it('answers without an inventory when the filesystem reports no such directory', async () => {
    const root = await workspace()
    await mkdir(join(root, 'uploads'))
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-7', root)
    vi.spyOn(ctx.fs, 'stat').mockRejectedValue(new FsError('gone', 'FS_NOT_FOUND'))

    expect(await runtimeContext(ctx, agent)).toBe('')
  })

  it('reports an unexpected filesystem failure instead of hiding it', async () => {
    const root = await workspace()
    await mkdir(join(root, 'uploads'))
    const ctx = await harness(root)
    await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-8', root)
    vi.spyOn(ctx.fs, 'stat').mockRejectedValue(new Error('provider exploded'))

    await expect(runtimeContext(ctx, agent)).rejects.toThrow('provider exploded')
  })

  it('stops contributing when the plugin is disposed', async () => {
    const root = await workspace()
    await mkdir(join(root, 'uploads'))
    await writeFile(join(root, 'uploads', 'a.txt'), 'a')
    const ctx = await harness(root)
    const fiber = await ctx.plugin(SessionUploads, {})
    const agent = stubAgent(ctx, 'session-9', root)
    expect(await runtimeContext(ctx, agent)).toContain('uploads/a.txt')

    await fiber.dispose()

    expect(await runtimeContext(ctx, agent)).toBe('')
    expect(CONTEXT_NAME).toBe('context:session-uploads')
  })

  it('rejects a directory name that escapes the session directory', async () => {
    const ctx = await harness(await workspace())
    await expect(ctx.plugin(SessionUploads, { directory: '' })).rejects.toThrow(/relative path/)
    await expect(ctx.plugin(SessionUploads, { directory: '../outside' })).rejects.toThrow(/relative path/)
    await expect(ctx.plugin(SessionUploads, { directory: '/abs' })).rejects.toThrow(/relative path/)
    await expect(ctx.plugin(SessionUploads, { directory: '\\abs' })).rejects.toThrow(/relative path/)
  })

  it('rejects a zero or fractional entry bound', async () => {
    const ctx = await harness(await workspace())
    await expect(ctx.plugin(SessionUploads, { maxEntries: 0 })).rejects.toThrow()
    await expect(ctx.plugin(SessionUploads, { maxEntries: 1.5 })).rejects.toThrow()
  })
})
