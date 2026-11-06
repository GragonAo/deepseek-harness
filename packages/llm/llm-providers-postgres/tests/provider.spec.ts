// The deployment-wide provider registry: one llm_providers unit opened outside
// any tenant scope, holding the whole catalog in its global singleton, so every
// tenant reads the same routes. Writes issued from inside a request's tenant
// scope must still reach that one registry.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from '@deepseek-ai/dsh-storage-postgres'
import type { SqlExecutor } from '@deepseek-ai/dsh-storage-postgres'
import { TenantId, TenantPartitionScope, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
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

/** A record an administrator would add for the whole harness. */
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
 * In-memory stand-in for the kv_case_global table: it keeps one value per
 * (schema, unit) so a test can prove which schema a write reached, that the
 * system schema is the only one the registry ever addresses, and that the whole
 * catalog rides a single global value.
 */
class SharedExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly globals = new Map<string, unknown>()

  async query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push(values === undefined ? { text } : { text, values })
    const schema = /\b(?:FROM|INTO) (\S+)\.kv_case_global/.exec(text)?.[1]
    if (schema === undefined) return []
    const unit = String(values?.[0])
    if (text.startsWith('SELECT value')) {
      const stored = this.globals.get(schema + '|' + unit)
      return stored === undefined ? [] : [{ value: stored }]
    }
    if (text.startsWith('INSERT')) {
      this.globals.set(schema + '|' + unit, JSON.parse(String(values?.[1])))
      return []
    }
    return []
  }

  /** Every schema the global singleton was addressed in. */
  schemas(): string[] {
    return [...new Set(this.calls
      .map(call => /\b(?:FROM|INTO) (\S+)\.kv_case_global/.exec(call.text)?.[1])
      .filter((schema): schema is string => schema !== undefined))]
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
  it('starts empty without reading a tenant', async () => {
    const { ctx, executor } = await boot()
    await expect(ctx.llmProviders.list()).resolves.toEqual([])
    expect((executor as SharedExecutor).schemas()).toEqual(['dsh_system'])
  })

  it('writes the whole catalog into the system schema global singleton', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    await ctx.llmProviders.upsert(record())

    const insert = executor.calls.find(call => call.text.startsWith('INSERT') && call.text.includes('dsh_system.kv_case_global'))
    expect(insert, 'routes the write to the system schema').toBeDefined()
    expect(insert!.text).not.toContain('user_id')
    expect(insert!.values?.[0]).toBe('llm_providers')
    expect(JSON.parse(String(insert!.values?.[1]))).toEqual({ providers: [record()] })
  })

  it('keeps the catalog in one value rather than one row per provider', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    await ctx.llmProviders.upsert(record())
    await ctx.llmProviders.upsert(record({ id: 'globex-gateway', displayName: 'Globex Gateway' }))

    const writes = executor.calls.filter(call => call.text.startsWith('INSERT') && call.text.includes('kv_case_global'))
    expect(writes).toHaveLength(2)
    expect(executor.schemas()).toEqual(['dsh_system'])
    const stored = await ctx.llmProviders.list()
    expect(stored.map(entry => entry.id)).toEqual(['acme-gateway', 'globex-gateway'])
  })

  it('serves one registry to every tenant, whichever scope reads it', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    await ctx.llmProviders.upsert(record())

    for (const reader of ['acme', 'globex']) {
      const listed = await scoped(tenant(reader), 'user-1', () => ctx.llmProviders.list())
      expect(listed.map(entry => entry.id), reader + ' reads the deployment registry').toEqual(['acme-gateway'])
      expect(listed[0]!.baseURL).toBe('https://gateway.acme.example/v1')
    }
    // Every read addressed the system schema; no tenant schema was ever touched.
    expect(executor.schemas()).toEqual(['dsh_system'])
  })

  it('keeps writing to the system schema when the write arrives inside a tenant scope', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    await scoped(tenant('acme'), 'user-1', () => ctx.llmProviders.upsert(record({ displayName: 'Written in scope' })))

    expect(executor.schemas()).toEqual(['dsh_system'])
    const readBack = await ctx.llmProviders.list()
    expect(readBack.map(entry => entry.displayName)).toEqual(['Written in scope'])
  })

  it('replaces a record on upsert and notifies listeners after each write', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    const changes: string[] = []
    cleanups.push(ctx.effect(() => ctx.llmProviders.onChange(() => changes.push('changed')), 'test: change listener'))

    await ctx.llmProviders.upsert(record())
    await ctx.llmProviders.upsert(record({ displayName: 'Acme Gateway 2' }))
    await ctx.llmProviders.remove('acme-gateway')

    expect(changes).toEqual(['changed', 'changed', 'changed'])
    const stored = await ctx.llmProviders.list()
    expect(stored).toEqual([])
  })

  it('does not report a removal that changed nothing', async () => {
    const { ctx } = await boot()
    const changes: string[] = []
    cleanups.push(ctx.effect(() => ctx.llmProviders.onChange(() => changes.push('changed')), 'test: change listener'))

    await ctx.llmProviders.remove('never-stored')

    expect(changes).toEqual([])
  })

  it('caches the loaded set for synchronous snapshot reads', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    expect(ctx.llmProviders.snapshot()).toEqual([])
    await ctx.llmProviders.refresh()
    await ctx.llmProviders.upsert(record())
    expect(ctx.llmProviders.snapshot().map(entry => entry.id)).toEqual(['acme-gateway'])
    // The snapshot is the deployment registry, not a scope-conditional view.
    expect(scoped(tenant('globex'), 'user-9', () => ctx.llmProviders.snapshot()).map(entry => entry.id))
      .toEqual(['acme-gateway'])
  })

  it('notifies on a write but not on a refresh that observes no change', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    const changes: string[] = []
    cleanups.push(ctx.effect(() => ctx.llmProviders.onChange(() => changes.push('changed')), 'test: change listener'))
    await ctx.llmProviders.upsert(record())
    await ctx.llmProviders.refresh()
    expect(changes).toEqual(['changed'])
  })

  it('refuses an unusable record before writing anything', async () => {
    const executor = new SharedExecutor()
    const { ctx } = await boot(executor)
    const unusable = { ...record(), baseURL: '' }
    await expect(ctx.llmProviders.upsert(unusable as LlmProviderRecord)).rejects.toThrow(/baseURL/)
    expect(executor.calls.filter(call => call.text.includes('kv_case_global') && call.text.startsWith('INSERT'))).toEqual([])
  })
})
