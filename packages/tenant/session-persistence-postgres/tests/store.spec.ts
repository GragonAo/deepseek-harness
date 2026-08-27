import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { TenantId, UserId, runWithTenant, runWithUser, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { PostgresSessionStore } from '../src/store.ts'
import type { SqlExecutor } from '../src/executor.ts'

function tenant(id: string): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/workspace/${id}`,
  }
}

function header(id: string): SessionHeader {
  return { version: 0, id: id as SessionId, createdAt: 0 }
}

function ev(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: 1000 + seq, data: { turn: 1 } }
}

/** Enter the ambient (tenant, user) scope most request paths run under. */
function scoped<T>(t: Tenant, user: string, fn: () => T): T {
  return runWithTenant(t, () => runWithUser(UserId(user), fn))
}

/** Records statements (plus a handler map for selected SELECT results). */
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

  async transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return fn(this)
  }

  async close(): Promise<void> {}
}

describe('PostgresSessionStore', () => {
  it('fails closed when no tenant is in scope', async () => {
    const store = new PostgresSessionStore(new RecordingExecutor())
    await expect(store.loadStored('s1' as SessionId)).rejects.toMatchObject({ code: 'NO_TENANT_IN_SCOPE' })
  })

  it('fails closed when a tenant but no user is in scope', async () => {
    const store = new PostgresSessionStore(new RecordingExecutor())
    await expect(runWithTenant(tenant('acme'), () => store.loadStored('s1' as SessionId)))
      .rejects.toMatchObject({ code: 'NO_USER_IN_SCOPE' })
  })

  it('lists nothing when no tenant or user is in scope (boot-time global sweeps index nothing)', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    await expect(store.list()).resolves.toEqual([])
    await expect(store.listSnapshots()).resolves.toEqual([])
    expect(executor.calls).toEqual([])
  })

  it('binds the owning (tenant, user) at materialize so a later flush stays in-scope', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    const schema = tenantPartitionName(TenantId('acme'))
    await scoped(tenant('acme'), 'user-1', () => store.appendBatch(header('s1'), [ev(0), ev(1)], false))
    // Async flush outside any scope still targets the bound schema and user.
    await store.appendBatch(header('s1'), [ev(2)], true)
    expect(executor.calls.some(c => c.text.includes(`${schema}.session_meta`) && c.text.includes('INSERT'))).toBe(true)
    const eventInsert = executor.calls.filter(c => c.text.includes(`${schema}.session_event`) && c.text.includes('INSERT'))
    expect(eventInsert.length).toBeGreaterThanOrEqual(3)
    // Every event insert carries the bound user id.
    expect(eventInsert.every(c => c.values?.[1] === 'user-1')).toBe(true)
  })

  it('returns undefined for a tenant that does not own the id', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    const globex = tenantPartitionName(TenantId('globex'))
    const result = await scoped(tenant('globex'), 'user-1', () => store.loadStored('s1' as SessionId))
    expect(result).toBeUndefined()
    expect(executor.calls.some(c => c.text.includes(`${globex}.session_meta`))).toBe(true)
  })

  it('returns undefined for a user of the same tenant that does not own the id', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    const schema = tenantPartitionName(TenantId('acme'))
    // user-1 materialized s1; user-2 reads it and sees nothing (persistence
    // filtering by user_id makes the id unaddressable across users).
    await scoped(tenant('acme'), 'user-1', () => store.appendBatch(header('s1'), [ev(0)], false))
    const result = await scoped(tenant('acme'), 'user-2', () => store.loadStored('s1' as SessionId))
    expect(result).toBeUndefined()
    expect(executor.calls.some(c => c.text.includes(`${schema}.session_meta`) && c.values?.[1] === 'user-2')).toBe(true)
  })

  it('lists only the ambient user’s sessions within the tenant', async () => {
    const executor = new RecordingExecutor()
      .on('session_meta WHERE user_id', () => [{
        id: 's1',
        user_id: 'user-1',
        tenant_id: 'acme',
        version: 0,
        created_at: 42,
        revision: 1,
      }])
    const store = new PostgresSessionStore(executor)
    const result = await scoped(tenant('acme'), 'user-2', () => store.list())
    expect(result.map(h => h.id)).toEqual(['s1'])
    expect(executor.calls.some(c => c.text.includes('WHERE user_id = $1') && c.values?.[0] === 'user-2')).toBe(true)
  })

  it('reconstructs the header and events for the owning (tenant, user)', async () => {
    const executor = new RecordingExecutor()
      .on('session_meta WHERE id', () => [{
        id: 's1',
        user_id: 'user-1',
        tenant_id: 'acme',
        version: 0,
        created_at: 42,
        cwd: '/work',
        origin: 'subagent',
        revision: 3,
      }])
      .on('session_event WHERE id', () => [{ event: ev(0) }, { event: ev(1) }])
    const store = new PostgresSessionStore(executor)
    const result = await scoped(tenant('acme'), 'user-1', () => store.loadStored('s1' as SessionId))
    expect(result).toBeDefined()
    expect(result?.meta.cwd).toBe('/work')
    expect(result?.meta.origin).toBe('subagent')
    expect(result?.events.map(e => e.seq)).toEqual([0, 1])
    expect(result?.revision).toBe(`${tenantPartitionName(TenantId('acme'))}:s1:3`)
  })

  it('refuses a row whose stored tenant disagrees with the ambient tenant', async () => {
    const executor = new RecordingExecutor()
      .on('session_meta WHERE id', () => [{
        id: 's1',
        user_id: 'user-1',
        tenant_id: 'globex',
        version: 0,
        created_at: 0,
        revision: 1,
      }])
    const store = new PostgresSessionStore(executor)
    await expect(scoped(tenant('acme'), 'user-1', () => store.loadStored('s1' as SessionId))).rejects.toThrow(/disagrees/)
  })

  it('routes commitRepair closers to the bound (tenant, user) schema', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    const schema = tenantPartitionName(TenantId('acme'))
    await scoped(tenant('acme'), 'user-1', () => store.appendBatch(header('s1'), [ev(0)], false))
    await store.commitRepair(header('s1'), undefined, [ev(1)])
    expect(executor.calls.some(c => c.text.includes(`INSERT INTO ${schema}.session_event`))).toBe(true)
    expect(executor.calls.some(c => c.text.includes(`UPDATE ${schema}.session_meta SET revision = revision + 1`))).toBe(true)
  })
})
