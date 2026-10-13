import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import * as ObjectStore from '../src/index.ts'
import { startFakeS3 } from './fake-s3.ts'
import type { FakeS3 } from './fake-s3.ts'

const SIGNAL = new AbortController().signal
let callNumber = 0

const contexts: Context[] = []
const roots: string[] = []
const servers: FakeS3[] = []

beforeEach(() => {
  vi.stubEnv('DSH_OBJECT_ACCESS_KEY', 'AKIAEXAMPLE')
  vi.stubEnv('DSH_OBJECT_SECRET_KEY', 'secret-example')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  await Promise.all(servers.splice(0).map(server => server.close()))
})

/** 一个启动好的部署：插件、调用主体的挂载，以及它写入的假存储。 */
interface Harness {
  readonly ctx: Context
  readonly tenant: Tenant
  readonly workspace: string
  readonly global: string
  readonly s3: FakeS3
}

/**
 * 在真实临时目录上启动发布工具，并按容器 provider 的绑定方式备好主体的挂载。
 * @param options - 覆写项：单文件上限、是否校验公开性、匿名读开关。
 * @returns 启动好的部署。
 */
async function boot(options: {
  maxBytes?: number
  verifyPublic?: boolean
  publicRead?: boolean
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-object-store-'))
  roots.push(root)
  const workspaceRoot = join(root, 'cases', 'acme', 'workspace')
  const workspace = join(workspaceRoot, 'users', 'user-1')
  const global = join(root, 'users', 'user-1')
  await mkdir(workspace, { recursive: true })
  await mkdir(global, { recursive: true })
  const s3 = await startFakeS3({ publicRead: options.publicRead ?? true })
  servers.push(s3)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ObjectStore, {
    endpoint: s3.origin,
    bucket: 'dsh-public',
    publicBaseUrl: s3.origin,
    usersRoot: join(root, 'users'),
    maxBytes: options.maxBytes ?? 1024 * 1024,
    verifyPublic: options.verifyPublic ?? true,
  })
  return { ctx, tenant: { id: TenantId('acme'), name: 'acme', dataRoot: join(root, 'data'), workspaceRoot }, workspace, global, s3 }
}

/**
 * 以已鉴权主体调用工具。
 * @param harness - 启动好的部署。
 * @param args - 模型给的参数。
 * @returns 工具执行结果。
 */
function call(harness: Harness, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return runWithTenant(harness.tenant, () => runWithUser(UserId('user-1'), () => harness.ctx.tools.execute({
    signal: SIGNAL,
    callId: CallId(`object-call-${++callNumber}`),
    name: 'object_publish',
    arguments: args,
  })))
}

/** 结果里的文本。 */
function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('object_publish', () => {
  it('uploads the file and returns a public address under the case and the subject', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, '报告.docx'), 'report body')
    const result = await call(harness, { file_path: '/workspace/报告.docx' })
    expect(result.isError).toBe(false)
    const value = result.value as { key: string; url: string; bytes: number; content_type: string }
    expect(value.key).toMatch(/^acme\/user-1\/\d{8}_\d{6}_报告\.docx$/)
    // 键里的非 ASCII 段在地址里按 URL 规范编码，取用时解码回来仍是同一个键。
    expect(value.url.startsWith(`${harness.s3.origin}/dsh-public/acme/user-1/`)).toBe(true)
    expect(decodeURIComponent(new URL(value.url).pathname.slice(1))).toBe(`dsh-public/${value.key}`)
    expect(value.bytes).toBe('report body'.length)
    expect(value.content_type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(new TextDecoder().decode(harness.s3.objects.get(value.key))).toBe('report body')
    // 库拉取到的地址就是这条：不带凭据的读必须成功。
    expect((await fetch(value.url, { method: 'HEAD' })).status).toBe(200)
    expect(text(result)).toContain(value.url)
  })

  it('projects the published address into the result meta so a front end need not parse text', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, '销售.csv'), 'a,b\n1,2\n')
    const result = await call(harness, { file_path: '/workspace/销售.csv' })
    expect(result.isError).toBe(false)
    const value = result.value as { key: string; url: string }
    // 前端读的就是这里：与声明式输出同一批字段，回放日志能还原同一张卡片。
    expect(result.meta).toEqual({
      key: value.key,
      url: value.url,
      bytes: 'a,b\n1,2\n'.length,
      content_type: 'text/csv; charset=utf-8',
      source_path: '/workspace/销售.csv',
    })
  })

  it('reads from the subject\'s own mounts only and resolves relative paths against the working directory', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, '报告.docx'), 'body')
    await writeFile(join(harness.global, '导出.csv'), 'a,b\n1,2\n')
    const relative = await call(harness, { file_path: '报告.docx' })
    expect(relative.isError).toBe(false)
    expect((relative.value as { source_path: string }).source_path).toBe('/workspace/报告.docx')
    const absolute = await call(harness, { file_path: '/global/导出.csv' })
    expect(absolute.isError).toBe(false)
    const value = absolute.value as { key: string; source_path: string }
    expect(value.key).toMatch(/^acme\/user-1\/\d{8}_\d{6}_导出\.csv$/)
    expect(value.source_path).toBe('/global/导出.csv')
    expect(text(await call(harness, { file_path: '/etc/passwd' }))).toContain('is not inside the paths this subject can publish from')
  })

  it('reports a missing file as missing and a directory as not a regular file', async () => {
    const harness = await boot()
    expect(text(await call(harness, { file_path: '/workspace/absent.docx' }))).toContain('does not exist')
    await mkdir(join(harness.workspace, 'folder'))
    expect(text(await call(harness, { file_path: '/workspace/folder' }))).toContain('is not a regular file')
  })

  it('refuses a file above this deployment\'s limit', async () => {
    const harness = await boot({ maxBytes: 4 })
    await writeFile(join(harness.workspace, 'big.txt'), 'far too long for four bytes')
    expect(text(await call(harness, { file_path: '/workspace/big.txt' }))).toContain('above this deployment\'s 4-byte limit')
  })

  it('fails loud when the published object is not anonymously readable', async () => {
    const harness = await boot({ publicRead: false })
    await writeFile(join(harness.workspace, 'report.txt'), 'body')
    const result = await call(harness, { file_path: '/workspace/report.txt' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not publicly readable')
    expect(harness.s3.objects.size).toBe(1)
  })

  it('gives concurrent publishes of the same name their own keys', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, 'report.txt'), 'body')
    const first = await call(harness, { file_path: '/workspace/report.txt' })
    const second = await call(harness, { file_path: '/workspace/report.txt' })
    const keys = [first, second].map(result => (result.value as { key: string }).key)
    expect(keys[0]).not.toBe(keys[1])
    expect(harness.s3.objects.size).toBe(2)
  })

  it('honours a title and a content type override', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, 'raw.bin'), 'body')
    const result = await call(harness, { file_path: '/workspace/raw.bin', title: '季度汇总', content_type: 'text/csv' })
    const value = result.value as { key: string; content_type: string }
    expect(value.key).toMatch(/^acme\/user-1\/\d{8}_\d{6}_季度汇总\.bin$/)
    expect(value.content_type).toBe('text/csv')
  })

  it('takes the stem when the title repeats the source extension', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, 'sales.csv'), '月份,金额\n')
    const result = await call(harness, { file_path: '/workspace/sales.csv', title: 'sales.csv' })
    expect((result.value as { key: string }).key).toMatch(/^acme\/user-1\/\d{8}_\d{6}_sales\.csv$/)
  })

  it('keeps a title extension that differs from the source file', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, 'sales.csv'), '月份,金额\n')
    const result = await call(harness, { file_path: '/workspace/sales.csv', title: 'v1.2' })
    expect((result.value as { key: string }).key).toMatch(/^acme\/user-1\/\d{8}_\d{6}_v1\.2\.csv$/)
  })

  it('fails outside a case-scoped request instead of publishing to a shared location', async () => {
    const harness = await boot()
    await writeFile(join(harness.workspace, 'report.txt'), 'body')
    const result = await harness.ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('object-call-unscoped'),
      name: 'object_publish',
      arguments: { file_path: '/workspace/report.txt' },
    })
    expect(result.isError).toBe(true)
    expect(harness.s3.objects.size).toBe(0)
  })
})
