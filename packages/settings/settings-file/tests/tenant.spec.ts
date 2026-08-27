// Tenant-scoped documents: without an explicit `path`, each tenant reads and
// writes its own `settings.yaml` under its `dataRoot`, while the single-user
// (no-tenant) path stays at the harness home and an explicit `path` stays a
// fixed global document for every tenant.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TenantId, runWithTenant } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
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

function tenant(id: string, dataRoot: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot, workspaceRoot: join(dataRoot, 'workspace') }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-tenant-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof FileSettingsProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileSettingsProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('resolveActiveFilename', () => {
  it('scopes by dataRoot inside a tenant and by the harness home outside', async () => {
    const home = await tempDir()
    const dataRoot = join(home, 'acme')
    await runWithTenant(tenant('acme', dataRoot), () => {
      expect(resolveActiveFilename({ dshHome: home })).toBe(resolve(join(dataRoot, 'settings.yaml')))
    })
    expect(resolveActiveFilename({ dshHome: home })).toBe(resolve(join(home, 'settings.yaml')))
    const fixed = join(home, 'fixed', 'settings.yaml')
    expect(resolveActiveFilename({ path: fixed })).toBe(resolve(fixed))
  })
})

describe('tenant-scoped documents', () => {
  it('isolates each tenant under its own dataRoot', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home, watch: false })
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await runWithTenant(tenant('acme', join(home, 'acme')), () =>
      ctx.settings.update(ns, { theme: 'light' }))
    // The write landed under Acme's dataRoot, never the shared home.
    expect(await readFile(join(home, 'acme', 'settings.yaml'), 'utf8')).toContain('theme: light')

    // Tenant B resolves its own (still empty) document.
    await runWithTenant(tenant('globex', join(home, 'globex')), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })
    })
    // Acme still reads its own value back.
    await runWithTenant(tenant('acme', join(home, 'acme')), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
  })

  it('falls back to the global harness home outside any tenant scope', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home, watch: false })
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await ctx.settings.update(ns, { theme: 'light' })
    expect(ctx.settings.documentPath).toBe(join(home, 'settings.yaml'))
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('theme: light')
    expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
  })

  it('keeps an explicit path a fixed global document across tenants', async () => {
    const dir = await tempDir()
    const path = join(dir, 'fixed.yaml')
    const ctx = await boot({ path, watch: false })
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await runWithTenant(tenant('acme', join(dir, 'acme')), () =>
      ctx.settings.update(ns, { theme: 'light' }))
    // The explicit path — not Acme's dataRoot — received the write.
    expect(await readFile(path, 'utf8')).toContain('theme: light')
    // Every tenant shares that one document.
    await runWithTenant(tenant('globex', join(dir, 'globex')), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
    expect(ctx.settings.documentPath).toBe(path)
  })
})
