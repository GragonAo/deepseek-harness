import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { PartitionScope, RequestPartition } from '@deepseek-ai/dsh-partition-scope'
import { CREDENTIALS_FILENAME, activeCredentialFilename, LocalCredentialProvider } from '../src/index.ts'

const KEY = credentialRef('DSH_PARTITION_TEST')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-partition-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Ambient-partition provider a test drives directly, standing in for a tenancy carrier. */
class TestPartitionScope extends Service implements PartitionScope {
  constructor(ctx: Context, private partition: RequestPartition | undefined) {
    super(ctx, 'partitionScope')
  }

  current(): RequestPartition | undefined {
    return this.partition
  }

  /** Enter one partition for the duration of `run`, restoring the previous one. */
  async run<T>(partition: RequestPartition, run: () => T | Promise<T>): Promise<T> {
    const previous = this.partition
    this.partition = partition
    try {
      return await run()
    } finally {
      this.partition = previous
    }
  }
}

/** One ambient partition; the credentials layer reads only `dataRoot`. */
function partition(tenant: string, dataRoot: string): RequestPartition {
  return { tenant, tenantName: `tenant_${tenant}`, dataRoot }
}

/** Boot the provider over a fresh context whose ambient partition the test drives. */
async function boot(
  config: ConstructorParameters<typeof LocalCredentialProvider>[1],
): Promise<{ ctx: Context; scope: TestPartitionScope }> {
  const ctx = new Context()
  const scope = new TestPartitionScope(ctx, undefined)
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return { ctx, scope }
}

describe('activeCredentialFilename', () => {
  it('resolves <partition.dataRoot>/.credentials.yaml inside an ambient partition', () => {
    const ctx = new Context()
    new TestPartitionScope(ctx, partition('acme', '/partitions/acme'))

    expect(activeCredentialFilename(ctx, { dshHome: '/home' })).toBe(resolve('/partitions/acme/.credentials.yaml'))
  })

  it('falls back to the harness home outside any partition', () => {
    expect(activeCredentialFilename(new Context(), { dshHome: '/home' })).toBe(resolve('/home/.credentials.yaml'))
  })

  it('keeps an explicit path global, ignoring the ambient partition', () => {
    const ctx = new Context()
    new TestPartitionScope(ctx, partition('acme', '/partitions/acme'))

    expect(activeCredentialFilename(ctx, { path: '/fixed/creds.yaml' })).toBe(resolve('/fixed/creds.yaml'))
  })
})

describe('partition-scoped credentials', () => {
  it('isolates managed documents between partitions', async () => {
    const root = await tempDir()
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    const { ctx, scope } = await boot({ dshHome: join(root, 'home'), watch: false })
    const a = partition('acme', dirA)
    const b = partition('globex', dirB)

    await scope.run(a, () => ctx.credentials.set(KEY, 'sk-a'))
    // Set under A: B reads nothing, A reads it back.
    expect(await scope.run(b, () => ctx.credentials.resolve(KEY))).toBeUndefined()
    expect(await scope.run(a, () => ctx.credentials.resolve(KEY))).toEqual({ value: 'sk-a', source: 'file' })
    // Each document lives under its own partition's data root.
    expect(await readFile(join(dirA, CREDENTIALS_FILENAME), 'utf8')).toContain('sk-a')
    await expect(readFile(join(dirB, CREDENTIALS_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to $DSH_HOME/.credentials.yaml outside any partition', async () => {
    const root = await tempDir()
    const home = join(root, 'home')
    const { ctx } = await boot({ dshHome: home, watch: false })

    await ctx.credentials.set(KEY, 'global-value')
    expect(await readFile(join(home, CREDENTIALS_FILENAME), 'utf8')).toContain('global-value')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'global-value', source: 'file' })
  })

  it('an explicit config.path ignores partitioning', async () => {
    const root = await tempDir()
    const fixedPath = join(root, 'fixed.yaml')
    const dirA = join(root, 'a')
    const { ctx, scope } = await boot({ path: fixedPath, watch: false })
    const a = partition('acme', dirA)

    await scope.run(a, () => ctx.credentials.set(KEY, 'fixed-value'))
    // The write lands in the fixed document, never the partition's data root.
    expect(await readFile(fixedPath, 'utf8')).toContain('fixed-value')
    await expect(readFile(join(dirA, CREDENTIALS_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await scope.run(a, () => ctx.credentials.resolve(KEY))).toEqual({ value: 'fixed-value', source: 'file' })
  })

  it('the inherited environment still wins over the partition-managed document', async () => {
    const root = await tempDir()
    const dirA = join(root, 'a')
    const { ctx, scope } = await boot({ dshHome: join(root, 'home'), watch: false })
    const a = partition('acme', dirA)

    await scope.run(a, () => ctx.credentials.set(KEY, 'stored'))
    vi.stubEnv('DSH_PARTITION_TEST', 'from-env')
    expect(await scope.run(a, () => ctx.credentials.resolve(KEY))).toEqual({ value: 'from-env', source: 'env' })
    expect(await scope.run(a, () => ctx.credentials.describe(KEY)))
      .toEqual({ configured: true, source: 'env', writable: false })
  })
})
