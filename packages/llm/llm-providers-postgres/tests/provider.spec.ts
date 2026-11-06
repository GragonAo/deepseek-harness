// The tenant provider registry: one case-shared llm_providers unit per tenant
// schema, written through the postgres backend and read back by every user of
// that tenant. Reads outside any tenant scope fail safe to the empty list.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from '@deepseek-ai/dsh-storage-postgres'
import type { SqlExecutor } from '@deepseek-ai/dsh-storage-postgres'
import { TenantId, TenantPartitionScope, UserId, runWithTenant, runWithUser, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import type { LlmProviderRecord } from '@deepseek-ai/dsh-llm'
import PostgresLlmProviderStore from '../src/index.ts'

function tenant(id: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: '/data/' + id, workspaceRoot: '/workspace/' + id }
}

/** Enter the ambient (tenant, user) scope request paths run under. */
function scoped<T>(scope: Tenant, user: string, fn: () => T): T {
  return runWithTenant(scope, () => runWithUser(UserId(user), fn))
}

/** A record an administrator would add for one tenant. */
function record(overrides: Partial<LlmProviderRecord> = {}): LlmProviderRecord {
  return {
    id: 'acme-gateway',
    displayName: 'Acme Gateway',
    api: 'openai-completions',
    baseURL: 'https://gateway.acme.example/v1',
    models: [{ id: 'acme-large', name: 'Acme Large' }],
    enabled: true,
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * In-memory stand-in for the tenant schema's kv_case_record table: it keeps
 * rows keyed by (schema, unit, table, key) so a test can prove which table a
 * write reached and whether tenants stay isolated.
 */
class SharedExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly rows = new Map<string, unknown>()

  async query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push(values === undefined ? { text } : { text, values })
    const schema = /\b(?:FROM|INTO) (\S+)\.kv_case_record/.exec(text)?.[1]
    if (schema === undefined) return []
    const unit = String(values?.[0])
    if (text.startsWith('SELECT table_name, key, value')) {
      const prefix = [schema, unit].join('|') + '|'
      return [...this.rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => {
          const [, , table, entry] = key.split('|')
          return { table_name: table, key: entry, value }
        })
    }
    if (text.startsWith('INSERT')) {
      const [, table, entry, payload] = values as [string, string, string, string]
      this.rows.set([schema, unit, table, entry].join('|'), JSON.parse(payload))
      return []
    }
    if (text.startsWith('DELETE')) {
      const [, table, entry] = values as [string, string, string]
      this.rows.delete([schema, unit, table, entry].join('|'))
      return []
    }
    return []
  }

  async close(): Promise<void> {}
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Boot the storage hub, a postgres backend over the executor, and the registry. */
async function boot(executor: SqlExecutor = new SharedExecutor()): Promise<{ ctx: Context; executor: SqlExecutor }> {
  const ctx = new Context()
  ctx.provide('partitionScope', new TenantPartitionScope())
  await ctx.plugin(Storage)
  const backend = new PostgresStorageBackend(executor)
  const unregister = ctx.storage.backend.register('postgres', backend)
  ctx.provide(storageBackendServiceKey('postgres'), backend)
  const fiber = ctx.plugin(PostgresLlmProviderStore)
  cleanups.push(async () => {
    await fiber.dispose()
    unregister()
    await backend.close()
  })
  await fiber
  return { ctx, executor }
}

describe('PostgresLlmProviderStore', () => {
  it('lists nothing outside any tenant scope and never touches Postgres', async () => {
    const { ctx, executor } = await boot()
    await expect(ctx.llmProviders.list()).resolves.toEqual([])
    expect((executor as SharedExecutor).calls).toEqual([])
  })

  it('stores a record in the tenant-shared table without a user partition', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.upsert(record()))

    const schema = tenantPartitionName(TenantId('acme'))
    const insert = executor.calls.find(call => call.text.startsWith('INSERT') && call.text.includes(schema + '.kv_case_record'))
    expect(insert, 'routes the write to the tenant schema').toBeDefined()
    expect(insert!.text).toContain('INSERT')
    expect(insert!.text).not.toContain('user_id')
    expect(insert!.values?.[0]).toBe('llm_providers')
    expect(insert!.values?.[1]).toBe('provider')
    expect(insert!.values?.[2]).toBe('acme-gateway')
    expect(JSON.parse(String(insert!.values?.[3]))).toEqual(record())
  })

  it('serves one registry to every user of a tenant and nothing to another tenant', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.upsert(record()))

    const readByColleague = await scoped(tenant('acme'), 'user-2', () => ctx.llmProviders.list())
    expect(readByColleague.map(entry => entry.id)).toEqual(['acme-gateway'])
    expect(readByColleague[0]!.baseURL).toBe('https://gateway.acme.example/v1')

    const otherTenant = await scoped(tenant('globex'), 'user-1', () => ctx.llmProviders.list())
    expect(otherTenant).toEqual([])
  })

  it('replaces a record on upsert and notifies listeners after each write', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    const changes: string[] = []
    cleanups.push(ctx.effect(() => ctx.llmProviders.onChange(() => changes.push('changed')), 'test: change listener'))

    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.upsert(record()))
    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.upsert(record({ displayName: 'Acme Gateway 2' })))
    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.remove('acme-gateway'))

    expect(changes).toEqual(['changed', 'changed', 'changed'])
    const stored = await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.list())
    expect(stored).toEqual([])
  })

  it('caches the loaded set for synchronous snapshot reads', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    await scoped(tenant('acme'), 'user-1', async () => {
      expect(ctx.llmProviders.snapshot()).toEqual([])
      await ctx.llmProviders.refresh()
      expect(ctx.llmProviders.snapshot()).toEqual([])
      await ctx.llmProviders.upsert(record())
      expect(ctx.llmProviders.snapshot().map(entry => entry.id)).toEqual(['acme-gateway'])
    })
    // Outside the scope the synchronous read answers nothing rather than leaking.
    expect(ctx.llmProviders.snapshot()).toEqual([])
  })

  it('notifies on a write but not on a refresh that observes no change', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    const changes: string[] = []
    cleanups.push(ctx.effect(() => ctx.llmProviders.onChange(() => changes.push('changed')), 'test: change listener'))
    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.upsert(record()))
    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.refresh())
    expect(changes).toEqual(['changed'])
  })

  it('refuses an unusable record before writing anything', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    const unusable = { ...record(), baseURL: '' }
    await expect(scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.upsert(unusable as LlmProviderRecord)))
      .rejects.toThrow(/baseURL/)
    expect(executor.calls.filter(call => call.text.includes('INSERT'))).toEqual([])
  })

  it('refuses a write outside any tenant scope', async () => {
    const { ctx } = await boot()
    await expect(ctx.llmProviders.upsert(record())).rejects.toMatchObject({ code: 'NO_TENANT_IN_SCOPE' })
  })
})
