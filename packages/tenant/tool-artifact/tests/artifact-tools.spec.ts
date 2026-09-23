import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import * as ToolArtifact from '../src/index.ts'

const SIGNAL = new AbortController().signal
let callNumber = 0

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One booted deployment: the plugin, the subject's mounts, and the static directory it fills. */
interface Harness {
  /** The tool registry and the artifact tools. */
  readonly ctx: Context
  /** The case whose workspace the mounts come from. */
  readonly tenant: Tenant
  /** Host directory the container mounts at `/workspace` for the calling subject. */
  readonly workspace: string
  /** The subject's own directory under `mediaRoot`. */
  readonly library: string
}

/**
 * Boot the artifact tools over a real temporary deployment, with the subject's
 * `/workspace` mount present as the container provider would bind it.
 * @returns the booted harness.
 */
async function boot(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-artifact-'))
  roots.push(root)
  const mediaRoot = join(root, 'static')
  const workspaceRoot = join(root, 'cases', 'acme', 'workspace')
  const workspace = join(workspaceRoot, 'users', 'user-1')
  await mkdir(workspace, { recursive: true })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolArtifact, { mediaRoot, urlPrefix: '/media', groupByKind: true, maxBytes: 1024 * 1024 })
  return {
    ctx,
    tenant: { id: TenantId('acme'), name: 'acme', dataRoot: join(root, 'data'), workspaceRoot },
    workspace,
    library: join(mediaRoot, 'acme', 'user-1'),
  }
}

/**
 * Call one artifact tool as the authenticated subject, the scope the tools read their authority from.
 * @param harness - the booted deployment.
 * @param name - the tool to call.
 * @param args - the model-supplied arguments.
 * @returns the tool execution result.
 */
function call(harness: Harness, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return runWithTenant(harness.tenant, () => runWithUser(UserId('user-1'), () => harness.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(`artifact-call-${++callNumber}`),
    name,
    arguments: args,
  })))
}

/** The text a tool result carries, error or not. */
function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** An errno-coded filesystem failure, as `fs` reports one. */
function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/**
 * Make one filesystem call report a failure for one path. The plugin reaches `node:fs`'s promise
 * object at call time, so replacing a property on it is the syscall seam; this file's own named
 * imports keep the original bindings, so setup and cleanup still touch the real filesystem.
 * @param syscall - the call to fail.
 * @param target - the path whose call fails.
 * @param error - the failure it raises.
 * @returns a restore function to call once the assertion is done.
 */
function failFor(syscall: 'realpath' | 'readdir' | 'stat', target: string, error: NodeJS.ErrnoException): () => void {
  const real = fsp[syscall] as (path: string, options?: unknown) => Promise<unknown>
  const spy = vi.spyOn(fsp, syscall)
  // The replacement stands in for a call with several overloads, so it is typed as this mock's own
  // implementation parameter rather than as the two-argument function it is.
  const replacement = ((path: string, options?: unknown) => {
    if (path === target) return Promise.reject(error)
    return real(path, options)
  }) as typeof spy.mockImplementation extends (implementation: infer I) => unknown ? I : never
  spy.mockImplementation(replacement)
  return () => { spy.mockRestore() }
}

/**
 * Make the removal of any staging file under one directory fail. A staging name carries a random
 * uuid, so the failure is selected by the `.part` suffix every one of them ends in.
 * @param directory - the library directory whose staging files cannot be removed.
 * @param error - the failure the removal raises.
 * @returns a restore function to call once the assertion is done.
 */
function failStagingUnlink(directory: string, error: NodeJS.ErrnoException): () => void {
  const real = fsp.unlink
  const spy = vi.spyOn(fsp, 'unlink').mockImplementation(async (path) => {
    if (String(path).startsWith(directory) && String(path).endsWith('.part')) throw error
    await real(path)
  })
  return () => { spy.mockRestore() }
}

/** Write one file into the subject's workspace and deliver it, returning the delivered file name. */
async function publish(harness: Harness, fileName: string): Promise<string> {
  await writeFile(join(harness.workspace, fileName), 'artifact body')
  const result = await call(harness, 'artifact_publish', { file_path: `/workspace/${fileName}` })
  expect(result.isError).toBe(false)
  return (result.value as { name: string }).name
}

describe('artifact_publish source resolution', () => {
  it('delivers a file the subject wrote', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, 'report.docx'), 'artifact body')
    const result = await call(harness, 'artifact_publish', { file_path: '/workspace/report.docx' })
    expect(result.isError).toBe(false)
    expect((result.value as { public_path: string }).public_path).toMatch(/^\/media\/acme\/user-1\/docs\//)
  })

  it('reports a path it cannot resolve as that failure, not as absence', async () => {
    const harness = await boot()
    const source = join(harness.workspace, 'report.docx')
    await writeFile(source, 'artifact body')
    const restore = failFor('realpath', source, errno('EACCES', `EACCES: permission denied, realpath '${source}'`))
    try {
      const result = await call(harness, 'artifact_publish', { file_path: '/workspace/report.docx' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('EACCES')
      expect(text(result)).not.toContain('does not exist')
    } finally {
      restore()
    }
  })

  it('delivers the artifact even when removing the staging file fails', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, 'report.docx'), 'artifact body')
    const restore = failStagingUnlink(harness.library, errno('EACCES', 'EACCES: permission denied, unlink'))
    try {
      const result = await call(harness, 'artifact_publish', { file_path: '/workspace/report.docx' })
      expect(result.isError).toBe(false)
      expect((result.value as { attachment_tag: string }).attachment_tag).toContain('/media/acme/user-1/docs/')
    } finally {
      restore()
    }
  })

  it('still reports a path that is genuinely absent as absent', async () => {
    const harness = await boot()
    const result = await call(harness, 'artifact_publish', { file_path: '/workspace/missing.docx' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('file_path "/workspace/missing.docx" does not exist')
  })
})

describe('artifact_list failure reporting', () => {
  it('lists the deliveries of the calling subject', async () => {
    const harness = await boot()
    const name = await publish(harness, 'report.docx')
    const result = await call(harness, 'artifact_list', {})
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ total: 1, entries: [{ name, kind: 'docs' }] })
  })

  it('reports a library directory it cannot read instead of an empty library', async () => {
    const harness = await boot()
    await publish(harness, 'report.docx')
    const restore = failFor('readdir', harness.library, errno('EACCES', `EACCES: permission denied, scandir '${harness.library}'`))
    try {
      const result = await call(harness, 'artifact_list', {})
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('EACCES')
      expect(text(result)).not.toContain('Nothing has been delivered')
    } finally {
      restore()
    }
  })

  it('reports an entry it cannot examine instead of a shorter list', async () => {
    const harness = await boot()
    const name = await publish(harness, 'report.docx')
    const entry = join(harness.library, 'docs', name)
    const restore = failFor('stat', entry, errno('EACCES', `EACCES: permission denied, stat '${entry}'`))
    try {
      const result = await call(harness, 'artifact_list', {})
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('EACCES')
      expect(text(result)).not.toContain('Nothing has been delivered')
    } finally {
      restore()
    }
  })

  it('reports an empty library before the first delivery, which is absence and not a failure', async () => {
    const harness = await boot()
    const result = await call(harness, 'artifact_list', {})
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ entries: [], total: 0 })
  })

  it('skips an entry removed between the readdir and the stat, the one race it absorbs', async () => {
    const harness = await boot()
    const name = await publish(harness, 'report.docx')
    const entry = join(harness.library, 'docs', name)
    const restore = failFor('stat', entry, errno('ENOENT', `ENOENT: no such file or directory, stat '${entry}'`))
    try {
      const result = await call(harness, 'artifact_list', {})
      expect(result.isError).toBe(false)
      expect(result.value).toEqual({ entries: [], total: 0 })
    } finally {
      restore()
    }
  })
})
