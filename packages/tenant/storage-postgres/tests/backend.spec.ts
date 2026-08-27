import { describe, expect, it } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { TenantId, UserId, runWithTenant, runWithUser, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { PostgresStorageBackend } from '../src/backend.ts'
import type { SqlExecutor } from '../src/executor.ts'

function tenant(id: string): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/workspace/${id}`,
  }
}

function descriptor(overrides: Partial<KvUnitDescriptor> = {}): KvUnitDescriptor {
  return { name: 'memory', version: 1, tables: ['memory'], hasGlobal: true, ...overrides }
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

describe('PostgresStorageBackend', () => {
  it('rejects an invalid descriptor name', async () => {
    const backend = new PostgresStorageBackend(new RecordingExecutor())
    await expect(backend.kv.open(descriptor({ name: 'Bad-Name' }))).rejects.toMatchObject({
      code: 'malformed-medium',
    })
  })

  it('fails closed when no tenant is in scope', async () => {
    const backend = new PostgresStorageBackend(new RecordingExecutor())
    const unit = await backend.kv.open(descriptor())
    await expect(unit.putRecord('memory', 'k', { v: 1 })).rejects.toMatchObject({
      code: 'NO_TENANT_IN_SCOPE',
    })
  })

  it('fails closed when a tenant but no user is in scope', async () => {
    const backend = new PostgresStorageBackend(new RecordingExecutor())
    const unit = await backend.kv.open(descriptor())
    await expect(runWithTenant(tenant('acme'), () => unit.putRecord('memory', 'k', { v: 1 }))).rejects.toMatchObject({
      code: 'NO_USER_IN_SCOPE',
    })
  })

  it('routes writes to the ambient (tenant, user) schema and row only', async () => {
    const executor = new RecordingExecutor()
    const backend = new PostgresStorageBackend(executor)
    const unit = await backend.kv.open(descriptor())
    const acme = tenantPartitionName(TenantId('acme'))
    const globex = tenantPartitionName(TenantId('globex'))
    await scoped(tenant('acme'), 'user-1', () => unit.putRecord('memory', 'k', { v: 1 }))
    await scoped(tenant('globex'), 'user-2', () => unit.putRecord('memory', 'k', { v: 2 }))
    expect(executor.calls.some(c => c.text.includes(`${acme}.kv_record`))).toBe(true)
    expect(executor.calls.some(c => c.text.includes(`${globex}.kv_record`))).toBe(true)
    // No single statement can ever address two tenant schemas.
    for (const call of executor.calls) {
      if (call.text.includes('.kv_record')) {
        expect(call.text.includes(acme)).not.toBe(call.text.includes(globex))
      }
    }
    // Both writes carry their ambient user_id as the in-primary-key column.
    const acmeWrite = executor.calls.find(c => c.text.includes(`${acme}.kv_record`) && c.text.includes('INSERT'))
    const globexWrite = executor.calls.find(c => c.text.includes(`${globex}.kv_record`) && c.text.includes('INSERT'))
    expect(acmeWrite?.values?.[1]).toBe('user-1')
    expect(globexWrite?.values?.[1]).toBe('user-2')
  })

  it('keeps two users of one tenant apart in the same schema', async () => {
    const executor = new RecordingExecutor()
      .on('SELECT table_name, key, value', () => [{ table_name: 'memory', key: 'a', value: { x: 1 } }])
    const backend = new PostgresStorageBackend(executor)
    const unit = await backend.kv.open(descriptor())
    await scoped(tenant('acme'), 'user-1', () => unit.putRecord('memory', 'k', { owner: 'user-1' }))
    const read = await scoped(tenant('acme'), 'user-2', () => unit.loadAll())
    expect(read.tables).toEqual({ memory: { a: { x: 1 } } })
    // The read filtered by user-2, never user-1.
    const select = executor.calls.find(c => c.text.includes('SELECT table_name, key, value'))
    expect(select?.values?.[1]).toBe('user-2')
  })

  it('stamps each tenant unit version and rejects a mismatch', async () => {
    const executor = new RecordingExecutor().on('SELECT version', () => [{ version: 99 }])
    const backend = new PostgresStorageBackend(executor)
    const unit = await backend.kv.open(descriptor())
    await expect(scoped(tenant('acme'), 'user-1', () => unit.putRecord('memory', 'k', 1))).rejects.toMatchObject({
      code: 'version-mismatch',
    })
  })

  it('assembles tables and the global slot from stored rows', async () => {
    const executor = new RecordingExecutor()
      .on('SELECT table_name, key, value', () => [
        { table_name: 'memory', key: 'a', value: { x: 1 } },
        { table_name: 'memory', key: 'b', value: 'str' },
      ])
      .on('SELECT value FROM', () => [{ value: { g: true } }])
    const backend = new PostgresStorageBackend(executor)
    const unit = await backend.kv.open(descriptor())
    const result = await scoped(tenant('acme'), 'user-1', () => unit.loadAll())
    expect(result.tables).toEqual({ memory: { a: { x: 1 }, b: 'str' } })
    expect(result.global).toEqual({ g: true })
  })

  it('rejects operations after the unit is closed', async () => {
    const backend = new PostgresStorageBackend(new RecordingExecutor())
    const unit = await backend.kv.open(descriptor())
    await unit.close()
    await expect(scoped(tenant('acme'), 'user-1', () => unit.putRecord('memory', 'k', 1))).rejects.toMatchObject({
      code: 'closed',
    })
  })

  it('scopes the double-open guard per (tenant, user)', async () => {
    const backend = new PostgresStorageBackend(new RecordingExecutor())
    const acmeUnit = await scoped(tenant('acme'), 'user-1', () => backend.kv.open(descriptor()))
    // A different tenant opening the same name is a distinct unit, not a double-open.
    await scoped(tenant('globex'), 'user-1', () => backend.kv.open(descriptor()))
    // A different user of the same tenant is also a distinct unit.
    await scoped(tenant('acme'), 'user-2', () => backend.kv.open(descriptor()))
    // Reopening for the same (tenant, user) is still a caller bug.
    await expect(scoped(tenant('acme'), 'user-1', () => backend.kv.open(descriptor())))
      .rejects.toThrow(/already open/)

    await acmeUnit.close()
    // Closing acme+user-1's unit frees only that key; acme+user-1 can reopen.
    await scoped(tenant('acme'), 'user-1', () => backend.kv.open(descriptor()))
    await backend.close()
  })

  it('stores a case-shared unit under the tenant alone, needing no user', async () => {
    const executor = new RecordingExecutor()
    const backend = new PostgresStorageBackend(executor)
    const shared = descriptor({ shared: true })
    const unit = await scoped(tenant('acme'), 'user-1', () => backend.kv.open(shared))
    // A tenant scope alone suffices: the shared unit never reads the user.
    await runWithTenant(tenant('acme'), () => unit.putRecord('memory', 'k', { v: 1 }))
    await runWithTenant(tenant('acme'), () => unit.setGlobal({ g: true }))
    const put = executor.calls.find(c => c.text.includes('kv_case_record') && c.text.includes('INSERT'))
    expect(put).toBeDefined()
    expect(put!.values).toEqual(['memory', 'memory', 'k', JSON.stringify({ v: 1 })])
    const setGlobal = executor.calls.find(c => c.text.includes('kv_case_global') && c.text.includes('INSERT'))
    expect(setGlobal).toBeDefined()
    expect(setGlobal!.values).toEqual(['memory', JSON.stringify({ g: true })])
  })

  it('reads a case-shared unit from the shared tables without a user filter', async () => {
    const executor = new RecordingExecutor()
      .on('SELECT table_name, key, value', () => [{ table_name: 'memory', key: 'k', value: 'shared' }])
      .on('SELECT value FROM', () => [{ value: { g: true } }])
    const backend = new PostgresStorageBackend(executor)
    const unit = await scoped(tenant('acme'), 'user-1', () => backend.kv.open(descriptor({ shared: true })))
    const result = await runWithTenant(tenant('acme'), () => unit.loadAll())
    expect(result.tables).toEqual({ memory: { k: 'shared' } })
    expect(result.global).toEqual({ g: true })
    const recordsSelect = executor.calls.find(c => c.text.includes('kv_case_record') && c.text.includes('SELECT'))
    expect(recordsSelect).toBeDefined()
    expect(recordsSelect!.values).toEqual(['memory'])
    expect(recordsSelect!.text.includes('user_id')).toBe(false)
  })

  it('keeps a case-shared unit within its tenant schema', async () => {
    const executor = new RecordingExecutor()
    const backend = new PostgresStorageBackend(executor)
    const unit = await scoped(tenant('acme'), 'user-1', () => backend.kv.open(descriptor({ shared: true })))
    await runWithTenant(tenant('acme'), () => unit.putRecord('memory', 'k', 1))
    await runWithTenant(tenant('globex'), () => unit.putRecord('memory', 'k', 2))
    const acme = tenantPartitionName(TenantId('acme'))
    const globex = tenantPartitionName(TenantId('globex'))
    const calls = executor.calls.filter(c => c.text.includes('kv_case_record') && c.text.includes('INSERT'))
    expect(calls.some(c => c.text.includes(`${acme}.kv_case_record`))).toBe(true)
    expect(calls.some(c => c.text.includes(`${globex}.kv_case_record`))).toBe(true)
  })
})
