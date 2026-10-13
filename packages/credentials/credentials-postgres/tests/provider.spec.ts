// (Tenant, user)-keyed PostgreSQL credentials provider: the writable
// credential map lives in one `credentials_doc` KV unit under the ambient
// tenant's schema and per-user row. The inherited process environment still
// wins (read-only); the `.env` fallbacks carry over from the launch
// environment when the product CLI provided one. Reads outside any scope skip
// Postgres entirely.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from '@deepseek-ai/dsh-storage-postgres'
import type { SqlExecutor } from '@deepseek-ai/dsh-storage-postgres'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TenantId, UserId, TenantPartitionScope, runWithTenant, runWithUser, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import PostgresCredentialProvider from '../src/index.ts'

const KEY = credentialRef('DSH_POSTGRES_TEST_CRED')

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
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function boot(executor: SqlExecutor = new RecordingExecutor()): Promise<{ ctx: Context; executor: RecordingExecutor }> {
  const ctx = new Context()
  // The tenant plugin mounts the ambient partition; a bare context must mount
  // it explicitly, or the partition-keyed seam resolves partitionless.
  ctx.provide('partitionScope', new TenantPartitionScope())
  await ctx.plugin(Storage)
  const backend = new PostgresStorageBackend(executor)
  const unregister = ctx.storage.backend.register('postgres', backend)
  ctx.provide(storageBackendServiceKey('postgres'), backend)
  const fiber = ctx.plugin(PostgresCredentialProvider)
  cleanups.push(async () => {
    await fiber.dispose()
    unregister()
    await backend.close()
  })
  await fiber
  return { ctx, executor: executor as RecordingExecutor }
}

describe('PostgresCredentialProvider', () => {
  it('resolves nothing outside a tenant and refuses writes without one', async () => {
    const { ctx, executor } = await boot()
    await expect(ctx.credentials.resolve(KEY)).resolves.toBeUndefined()
    await expect(ctx.credentials.set(KEY, 'sk-a')).rejects.toMatchObject({ code: 'NO_TENANT_IN_SCOPE' })
    expect(executor.calls).toEqual([])
  })

  it('refuses writes for a tenant without a user', async () => {
    const { ctx } = await boot()
    await expect(runWithTenant(tenant('acme'), () => ctx.credentials.set(KEY, 'sk-a')))
      .rejects.toMatchObject({ code: 'NO_USER_IN_SCOPE' })
  })

  it('stores and reads a credential back through the (tenant, user) row', async () => {
    const executor = new RecordingExecutor()
      .on('SELECT table_name, key, value', () => [{ table_name: 'ref', key: KEY, value: 'sk-a' }])
    const { ctx } = await boot(executor)
    const schema = tenantPartitionName(TenantId('acme'))

    await scoped(tenant('acme'), 'user-1', () => ctx.credentials.set(KEY, 'sk-a'))
    const insert = executor.calls.find(c => c.text.includes(`${schema}.kv_record`) && c.text.includes('INSERT'))
    expect(insert, 'routes the write to the tenant schema').toBeDefined()
    expect(insert!.values).toEqual(['credentials_doc', 'user-1', 'ref', KEY, JSON.stringify('sk-a')])

    expect(await scoped(tenant('acme'), 'user-1', () => ctx.credentials.resolve(KEY)))
      .toEqual({ value: 'sk-a', source: 'postgres' })
  })

  it('isolates stored values between tenants', async () => {
    const globex = tenantPartitionName(TenantId('globex'))
    const executor = new RecordingExecutor()
      .on('SELECT table_name, key, value', () => [{ table_name: 'ref', key: KEY, value: 'sk-a' }])
    const { ctx } = await boot(executor)
    await scoped(tenant('globex'), 'user-1', () => ctx.credentials.resolve(KEY))
    // Globex's read touched only the globex schema.
    expect(executor.calls.every(c => !c.text.includes('.kv_record') || c.text.includes(`${globex}.kv_record`))).toBe(true)
  })

  it('isolates stored values between users of one tenant', async () => {
    const executor = new RecordingExecutor()
      .on('SELECT table_name, key, value', () => [{ table_name: 'ref', key: KEY, value: 'sk-a' }])
    const { ctx } = await boot(executor)
    // user-2 reads the same tenant and resolves only through its own user row.
    const read = await scoped(tenant('acme'), 'user-2', () => ctx.credentials.resolve(KEY))
    expect(read).toEqual({ value: 'sk-a', source: 'postgres' })
    const select = executor.calls.find(c => c.text.includes('SELECT table_name, key, value'))
    expect(select?.values?.[1]).toBe('user-2')
  })

  it('the inherited environment wins and shadows a stored value', async () => {
    const executor = new RecordingExecutor()
      .on('SELECT table_name, key, value', () => [{ table_name: 'ref', key: KEY, value: 'stored' }])
    const { ctx } = await boot(executor)
    vi.stubEnv(String(KEY), 'from-env')
    expect(await scoped(tenant('acme'), 'user-1', () => ctx.credentials.resolve(KEY)))
      .toEqual({ value: 'from-env', source: 'env' })
    expect(await scoped(tenant('acme'), 'user-1', () => ctx.credentials.describe(KEY)))
      .toEqual({ configured: true, source: 'env', writable: false })
    await expect(scoped(tenant('acme'), 'user-1', () => ctx.credentials.set(KEY, 'sk-b')))
      .rejects.toThrow(/shadowed/)
  })

  it('rejects an empty stored value and deletes on unset', async () => {
    const executor = new RecordingExecutor()
    const { ctx } = await boot(executor)
    await expect(scoped(tenant('acme'), 'user-1', () => ctx.credentials.set(KEY, 'x'))).resolves.toBeUndefined()
    await expect(scoped(tenant('acme'), 'user-1', () => ctx.credentials.set(KEY, '')))
      .rejects.toThrow(/empty value/)
    await scoped(tenant('acme'), 'user-1', () => ctx.credentials.unset(KEY))
    const schema = tenantPartitionName(TenantId('acme'))
    expect(executor.calls.some(c => c.text.includes(`${schema}.kv_record`) && c.text.includes('DELETE'))).toBe(true)
  })
})
