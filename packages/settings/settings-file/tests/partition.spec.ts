// Partition-scoped documents: without an explicit `path`, each partition reads
// and writes its own `settings.yaml` under its `dataRoot`, while the
// partitionless path stays at the harness home and an explicit `path` stays a
// fixed global document for every tenant.

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PartitionScope, RequestPartition } from '@deepseek-ai/dsh-partition-scope'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider, resolveActiveFilename } from '../src/index.ts'

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

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

/** One ambient partition; the settings-file provider reads only `dataRoot`. */
function partition(tenant: string, dataRoot: string): RequestPartition {
  return { tenant, tenantName: `tenant_${tenant}`, dataRoot }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-partition-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Boot the provider over a fresh context whose ambient partition the test drives. */
async function boot(
  config: ConstructorParameters<typeof FileSettingsProvider>[1],
): Promise<{ ctx: Context; scope: TestPartitionScope }> {
  const ctx = new Context()
  const scope = new TestPartitionScope(ctx, undefined)
  const fiber = ctx.plugin(FileSettingsProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return { ctx, scope }
}

describe('resolveActiveFilename', () => {
  it('scopes by dataRoot inside a partition and by the harness home outside', async () => {
    const home = await tempDir()
    const dataRoot = join(home, 'acme')
    const ctx = new Context()
    const scope = new TestPartitionScope(ctx, partition('acme', dataRoot))

    await scope.run(partition('acme', dataRoot), () => {
      expect(resolveActiveFilename(ctx, { dshHome: home })).toBe(resolve(join(dataRoot, 'settings.yaml')))
    })
    expect(resolveActiveFilename(new Context(), { dshHome: home })).toBe(resolve(join(home, 'settings.yaml')))
    const fixed = join(home, 'fixed', 'settings.yaml')
    expect(resolveActiveFilename(new Context(), { path: fixed })).toBe(resolve(fixed))
  })
})

describe('partition-scoped documents', () => {
  it('isolates each partition under its own dataRoot', async () => {
    const home = await tempDir()
    const { ctx, scope } = await boot({ dshHome: home, watch: false })
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await scope.run(partition('acme', join(home, 'acme')), () =>
      ctx.settings.update(ns, { theme: 'light' }))
    // The write landed under Acme's dataRoot, never the shared home.
    expect(await readFile(join(home, 'acme', 'settings.yaml'), 'utf8')).toContain('theme: light')

    // Tenant B resolves its own (still empty) document.
    await scope.run(partition('globex', join(home, 'globex')), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })
    })
    // Acme still reads its own value back.
    await scope.run(partition('acme', join(home, 'acme')), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
  })

  it('falls back to the global harness home outside any partition', async () => {
    const home = await tempDir()
    const { ctx } = await boot({ dshHome: home, watch: false })
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await ctx.settings.update(ns, { theme: 'light' })
    expect(ctx.settings.documentPath).toBe(join(home, 'settings.yaml'))
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('theme: light')
    expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
  })

  it('keeps an explicit path a fixed global document across partitions', async () => {
    const dir = await tempDir()
    const path = join(dir, 'fixed.yaml')
    const { ctx, scope } = await boot({ path, watch: false })
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await scope.run(partition('acme', join(dir, 'acme')), () =>
      ctx.settings.update(ns, { theme: 'light' }))
    // The explicit path — not Acme's dataRoot — received the write.
    expect(await readFile(path, 'utf8')).toContain('theme: light')
    // Every partition shares that one document.
    await scope.run(partition('globex', join(dir, 'globex')), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
    expect(ctx.settings.documentPath).toBe(path)
  })
})
