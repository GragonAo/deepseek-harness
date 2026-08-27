/**
 * Real-composition guard: the provider boots from a test-only cordis.yml
 * through the actual Loader + Include path, with a stub postgres backend
 * registered under `postgres` on the storage hub. A tenant write routes the
 * merged section into the tenant schema — proving the `static inject` of the
 * `storage.backend.postgres` service key orders backend registration ahead of
 * the provider, and that backends resolve through `ctx.storage.backend`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from '@deepseek-ai/dsh-storage-postgres'
import type { SqlExecutor } from '@deepseek-ai/dsh-storage-postgres'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { TenantId, UserId, runWithTenant, runWithUser, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import PostgresSettingsProvider from '../src/index.ts'

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

function tenant(id: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot: `/workspace/${id}` }
}

/** Enter the ambient (tenant, user) scope most request paths run under. */
function scoped<T>(t: Tenant, user: string, fn: () => T): T {
  return runWithTenant(t, () => runWithUser(UserId(user), fn))
}

class RecordingExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []

  async query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push(values === undefined ? { text } : { text, values })
    return []
  }

  async close(): Promise<void> {}
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; executor: RecordingExecutor }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-settings-postgres-composition-'))
  const executor = new RecordingExecutor()

  const stubPostgres = {
    name: 'test-postgres-backend',
    inject: ['storage'],
    apply: (ctx: Context) => {
      const backend = new PostgresStorageBackend(executor)
      ctx.effect(() => ctx.storage.backend.register('postgres', backend))
      ctx.provide(storageBackendServiceKey('postgres'), backend)
    },
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: test-postgres',
    "  name: 'test-postgres-backend'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-postgres'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-storage', Storage],
        ['test-postgres-backend', stubPostgres],
        ['@deepseek-ai/dsh-settings-postgres', PostgresSettingsProvider],
      ])
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, executor }
}

describe('settings-postgres real composition', () => {
  it('boots from cordis.yml and routes a tenant write to the tenant schema', async () => {
    const { ctx, executor } = await loadComposition()
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await scoped(tenant('acme'), 'user-1', () => ctx.settings.update(ns, { theme: 'light' }))
    const schema = tenantPartitionName(TenantId('acme'))
    expect(executor.calls.some(c => c.text.includes(`${schema}.kv_record`) && c.text.includes('INSERT'))).toBe(true)

    await scoped(tenant('acme'), 'user-1', async () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
  })
})
