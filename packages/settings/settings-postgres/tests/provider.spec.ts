// (Tenant, user)-keyed PostgreSQL settings provider: the raw document lives in
// one `settings_doc` KV unit under the ambient tenant's schema and per-user
// row, with no host-side file. Reads outside any scope are empty (fails safe);
// writes require a tenant and user and route through the postgres backend.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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

/** Records every statement; a handler map stubs selected SELECT results. */
class RecordingExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly handlers = new Map<string, () => readonly Record<string, unknown>[]>()

  on(substring: string, rows: () => readonly Record<string, unknown>[]): this {
    this.handlers.set(substring, rows)
    return this
  }

  async query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push(values === undefined ? { text } : { text, values })
    for (const [substring, handler] of this.handlers) {
      if (text.includes(substring)) return handler()
    }
    return []
  }

  async close(): Promise<void> {}
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Boot the storage hub + a mock postgres backend + the settings provider. */
async function boot(executor: SqlExecutor = new RecordingExecutor()): Promise<{ ctx: Context; executor: SqlExecutor }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new PostgresStorageBackend(executor)
  const unregister = ctx.storage.backend.register('postgres', backend)
  ctx.provide(storageBackendServiceKey('postgres'), backend)
  const fiber = ctx.plugin(PostgresSettingsProvider)
  cleanups.push(async () => {
    await fiber.dispose()
    unregister()
    await backend.close()
  })
  await fiber
  return { ctx, executor }
}

describe('PostgresSettingsProvider', () => {
  it('serves the empty document and refuses writes outside any scope', async () => {
    const { ctx, executor } = await boot()
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)
    // Fails safe: no postgres query outside a tenant or user scope.
    expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })
    expect((executor as RecordingExecutor).calls).toEqual([])
    await expect(ctx.settings.update(ns, { theme: 'light' })).rejects.toMatchObject({
      code: 'NO_TENANT_IN_SCOPE',
    })
  })

  it('refuses writes for a tenant without a user', async () => {
    const { ctx } = await boot()
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)
    await expect(runWithTenant(tenant('acme'), () => ctx.settings.update(ns, { theme: 'light' })))
      .rejects.toMatchObject({ code: 'NO_USER_IN_SCOPE' })
  })

  it('persists a merged section to the ambient (tenant, user) and reads it back', async () => {
    const executor = new RecordingExecutor()
    const { ctx } = await boot(executor)
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await scoped(tenant('acme'), 'user-1', () => ctx.settings.update(ns, { theme: 'light' }))
    const schema = tenantPartitionName(TenantId('acme'))
    const put = executor.calls.find(c => c.text.includes(`${schema}.kv_record`) && c.text.includes('INSERT'))
    expect(put, 'routes the write to the tenant schema').toBeDefined()
    expect(put!.values).toEqual(['settings_doc', 'user-1', 'section', 'ui-theme', JSON.stringify({ theme: 'light' })])

    // The same (tenant, user) reads the persisted section back (within this process).
    await scoped(tenant('acme'), 'user-1', async () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
  })

  it('loads a persisted section before its first write and isolates tenants', async () => {
    // Acme previously stored `theme: light`; globex stored nothing.
    const executor = new RecordingExecutor()
      .on('SELECT version FROM', () => [{ version: 1 }])
      .on('SELECT table_name, key, value', () => [
        { table_name: 'section', key: 'ui-theme', value: { theme: 'light' } },
      ])
    const { ctx } = await boot(executor)
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await scoped(tenant('acme'), 'user-1', () => ctx.settings.update(ns, { fontSize: 16 }))
    await scoped(tenant('acme'), 'user-1', async () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 16 })
    })
    // Tenant B's document resolves from its own (empty) store.
    await scoped(tenant('globex'), 'user-9', async () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })
    })
  })

  it('keeps two users of one tenant to separate settings documents', async () => {
    const executor = new RecordingExecutor()
    const { ctx } = await boot(executor)
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await scoped(tenant('acme'), 'user-1', () => ctx.settings.update(ns, { theme: 'light' }))
    // user-2's document is its own; the write above is not visible to it.
    await scoped(tenant('acme'), 'user-2', async () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })
    })
    // user-2 writes a different field; user-1 still sees its own document.
    await scoped(tenant('acme'), 'user-2', () => ctx.settings.update(ns, { fontSize: 20 }))
    await scoped(tenant('acme'), 'user-1', async () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
    // Each write carried its issuing user's id as the in-primary-key column.
    const inserts = executor.calls.filter(c => c.text.includes('kv_record') && c.text.includes('INSERT'))
    expect(inserts.map(c => c.values?.[1]).sort()).toEqual(['user-1', 'user-2'])
  })

  it('exposes no local document path (non-file storage)', async () => {
    const { ctx } = await boot()
    expect(ctx.settings.documentPath).toBeUndefined()
    await expect(ctx.settings.prepareDocument()).resolves.toBeUndefined()
  })
})
