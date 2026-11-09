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
    // One statement per flush, not one per event.
    expect(eventInsert).toHaveLength(2)
    // Both flushes carry the bound user id, one parameter set per row.
    expect(eventInsert.every(c => c.values?.includes('user-1'))).toBe(true)
  })

  it('appends one flush as multi-row statements, splitting only at the row cap', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    const schema = tenantPartitionName(TenantId('acme'))
    const many = Array.from({ length: 450 }, (_, seq) => ev(seq))
    await scoped(tenant('acme'), 'user-1', () => store.appendBatch(header('s1'), many, false))
    const inserts = executor.calls.filter(c => c.text.includes(`${schema}.session_event`) && c.text.includes('INSERT'))
    // 200 rows per statement: 450 events become 3 statements.
    expect(inserts.map(c => (c.values?.length ?? 0) / 4)).toEqual([200, 200, 50])
    expect(inserts[0]?.text).toContain('($1, $2, $3, $4::jsonb)')
    expect(inserts[0]?.text).toContain('($797, $798, $799, $800::jsonb)')
    // Every event lands exactly once, in seq order.
    expect(inserts.flatMap(c => (c.values ?? []).filter((_, index) => index % 4 === 2))).toEqual(many.map(event => event.seq))
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

  it('deletes both row sets through the bound (tenant, user) and releases the binding', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    const schema = tenantPartitionName(TenantId('acme'))
    await scoped(tenant('acme'), 'user-1', () => store.appendBatch(header('s1'), [ev(0)], false))

    // No ambient scope: the captured binding still owns the id, so the removal
    // targets the schema and user that materialized it — the same write-scope
    // rule appends follow.
    await store.remove('s1' as SessionId)

    expect(executor.calls).toContainEqual({
      text: `DELETE FROM ${schema}.session_event WHERE id = $1 AND user_id = $2`,
      values: ['s1', 'user-1'],
    })
    expect(executor.calls).toContainEqual({
      text: `DELETE FROM ${schema}.session_meta WHERE id = $1 AND user_id = $2`,
      values: ['s1', 'user-1'],
    })

    // The binding went with the rows: without it this unbound id needs a scope.
    await expect(store.remove('s1' as SessionId)).rejects.toMatchObject({ code: 'NO_TENANT_IN_SCOPE' })
  })

  it('deletes an unbound id in the ambient (tenant, user) scope and refuses an aborted signal', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    const schema = tenantPartitionName(TenantId('globex'))

    await scoped(tenant('globex'), 'user-2', () => store.remove('unbound' as SessionId))

    expect(executor.calls).toContainEqual({
      text: `DELETE FROM ${schema}.session_event WHERE id = $1 AND user_id = $2`,
      values: ['unbound', 'user-2'],
    })
    expect(executor.calls).toContainEqual({
      text: `DELETE FROM ${schema}.session_meta WHERE id = $1 AND user_id = $2`,
      values: ['unbound', 'user-2'],
    })

    const reason = new Error('removal cancelled')
    await expect(scoped(tenant('globex'), 'user-2', () =>
      store.remove('unbound' as SessionId, AbortSignal.abort(reason)))).rejects.toBe(reason)
  })
})

describe('PostgresSessionStore conversation index', () => {
  /** A human question: the only message source the list rule dates. */
  function question(seq: number, time: number): SessionEvent {
    return {
      type: 'user/message',
      seq,
      time,
      data: { id: 'm1', role: 'user', content: [], source: { kind: 'user' } },
    } as unknown as SessionEvent
  }

  /** A committed event that closes a turn without advancing a list fact. */
  function idle(seq: number): SessionEvent {
    return { type: 'turn/end', seq, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent
  }

  it('writes the index facts in the transaction that appends them', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    await scoped(tenant('acme'), 'user-1', () =>
      store.appendBatch(header('s1'), [ev(0), question(1, 5000)], false))
    const upsert = executor.calls.find(call => call.text.includes('INSERT INTO session_index'))
    // tenant, user, session, creation, started, last question time
    expect(upsert?.values?.slice(0, 6)).toEqual(['acme', 'user-1', 's1', 0, true, 5000])
  })

  it('seeds a row for a session that materializes with no events yet', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    await scoped(tenant('acme'), 'user-1', () => store.appendBatch(header('s1'), [], false))
    const upsert = executor.calls.find(call => call.text.includes('INSERT INTO session_index'))
    expect(upsert?.values?.slice(0, 6)).toEqual(['acme', 'user-1', 's1', 0, false, null])
  })

  it('leaves the row alone for a batch that advances no list fact', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    await scoped(tenant('acme'), 'user-1', () => store.appendBatch(header('s1'), [idle(0)], true))
    expect(executor.calls.filter(call => call.text.includes('INSERT INTO session_index'))).toEqual([])
  })

  it('drops the row with the log it describes', async () => {
    const executor = new RecordingExecutor()
    const store = new PostgresSessionStore(executor)
    await scoped(tenant('acme'), 'user-1', () => store.remove('s1' as SessionId))
    expect(executor.calls).toContainEqual({
      text: 'DELETE FROM session_index WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3',
      values: ['acme', 'user-1', 's1'],
    })
  })

  it('reports one subject\'s figures per tenant from the index', async () => {
    const executor = new RecordingExecutor().on('FROM session_index', () => [
      { tenant_id: 'acme', session_count: '3', last_prompt_at: '1700', updated_at: '1800' },
      { tenant_id: 'beta', session_count: '1', last_prompt_at: null, updated_at: '900' },
    ])
    const store = new PostgresSessionStore(executor)
    await expect(store.statsOf('user-1')).resolves.toEqual([
      { tenant: 'acme', sessionCount: 3, lastPromptAt: 1700, updatedAt: 1800 },
      { tenant: 'beta', sessionCount: 1, lastPromptAt: null, updatedAt: 900 },
    ])
    // The table is materialized once per process, however many reads follow.
    await store.statsOf('user-2')
    expect(executor.calls.filter(call => call.text.includes('CREATE TABLE IF NOT EXISTS session_index'))).toHaveLength(1)
  })

  it('counts only conversations that started a turn of their own', async () => {
    const executor = new RecordingExecutor().on('FROM session_index', () => [])
    const store = new PostgresSessionStore(executor)
    await store.statsOf('user-1')
    const query = executor.calls.find(call => call.text.includes('FROM session_index'))
    expect(query?.text).toContain('started AND parent_session IS NULL')
    expect(query?.values).toEqual(['user-1'])
  })

  it('rebuilds one tenant\'s rows from its stored partitions', async () => {
    const schema = tenantPartitionName(TenantId('acme'))
    const executor = new RecordingExecutor().on('INSERT INTO session_index', () => [
      { session_id: 's1' },
      { session_id: 's2' },
    ])
    const store = new PostgresSessionStore(executor)
    await expect(store.reindex('acme')).resolves.toBe(2)
    const rebuild = executor.calls.find(call => call.text.includes('INSERT INTO session_index'))
    expect(rebuild?.text).toContain(`FROM ${schema}.session_meta`)
    expect(rebuild?.text).toContain("e.event->>'type' = 'turn/start'")
  })
})
