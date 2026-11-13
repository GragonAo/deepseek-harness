// The postgres-backed registry: two shared units in the backend's system schema,
// one global document for the administrator's list and one record per user.
// The medium is an in-memory stand-in for the two kv tables, so a test can prove
// which schema and unit a write reached and what shape it stored.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from '@deepseek-ai/dsh-storage-postgres'
import type { SqlExecutor } from '@deepseek-ai/dsh-storage-postgres'
import { TenantPartitionScope } from '@deepseek-ai/dsh-tenant'
import { McpServerRevisionConflict } from '@deepseek-ai/dsh-mcp-servers'
import type { ExternalMcpServerRecord } from '@deepseek-ai/dsh-mcp-servers'
import PostgresMcpServerStore from '../src/index.ts'

/** A row an operator would register. */
function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { serverName: 'acme-tools', url: 'https://mcp.acme.example/rpc', ...overrides }
}

/**
 * In-memory stand-in for `kv_case_global` and `kv_case_record`: it keeps one
 * value per (schema, unit) and one row per (schema, unit, table, key), so a test
 * can prove which schema a write reached and that the two registries use
 * different shapes of that schema.
 */
class RegistryExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly globals = new Map<string, unknown>()
  private readonly records = new Map<string, unknown>()

  async query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push(values === undefined ? { text } : { text, values })
    const target = /\b(?:FROM|INTO) (\S+)\.(kv_case_global|kv_case_record)\b/.exec(text)
    if (target === null) return []
    const [, schema, kind] = target as unknown as [string, string, 'kv_case_global' | 'kv_case_record']
    const unit = String(values?.[0])
    if (kind === 'kv_case_global') {
      const key = `${schema}|${unit}`
      if (text.startsWith('SELECT')) {
        const value = this.globals.get(key)
        return value === undefined ? [] : [{ value }]
      }
      this.globals.set(key, JSON.parse(String(values?.[values.length - 1])))
      return []
    }
    const prefix = `${schema}|${unit}|`
    if (text.startsWith('SELECT')) {
      return [...this.records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => {
          const [, , tableName, entryKey] = key.split('|')
          return { table_name: tableName, key: entryKey, value }
        })
    }
    this.records.set(`${prefix}${String(values?.[1])}|${String(values?.[2])}`, JSON.parse(String(values?.[3])))
    return []
  }

  /** Every schema a kv table was addressed in. */
  schemas(): string[] {
    return [...new Set(this.calls
      .map(call => /\b(?:FROM|INTO) (\S+)\.(?:kv_case_global|kv_case_record)\b/.exec(call.text)?.[1])
      .filter((schema): schema is string => schema !== undefined))]
  }

  /** Every unit the executor was asked about, in first-address order. */
  units(): string[] {
    return [...new Set(this.calls
      .map(call => String(call.values?.[0]))
      .filter(unit => unit !== 'undefined'))]
  }

  /** Seed a stored global document, as a previous process would have left it. */
  seedGlobal(schema: string, unit: string, value: unknown): void {
    this.globals.set(`${schema}|${unit}`, value)
  }

  /** Seed a stored record, as a previous process would have left it. */
  seedRecord(schema: string, unit: string, table: string, key: string, value: unknown): void {
    this.records.set(`${schema}|${unit}|${table}|${key}`, value)
  }

  async close(): Promise<void> {}
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Boot the storage hub, a postgres backend over the executor, and the registry. */
async function boot(
  executor: SqlExecutor = new RegistryExecutor(),
  config: Record<string, unknown> = {},
): Promise<{ ctx: Context; executor: RegistryExecutor }> {
  const ctx = new Context()
  ctx.provide('partitionScope', new TenantPartitionScope())
  await ctx.plugin(Storage)
  const backend = new PostgresStorageBackend(executor)
  const unregister = ctx.storage.backend.register('postgres', backend)
  ctx.provide(storageBackendServiceKey('postgres'), backend)
  const fiber = ctx.plugin(PostgresMcpServerStore, config)
  cleanups.push(async () => {
    await fiber.dispose()
    unregister()
    await backend.close()
  })
  await fiber
  return { ctx, executor: executor as RegistryExecutor }
}

describe('PostgresMcpServerStore', () => {
  it('starts empty and addresses only the system schema', async () => {
    const { ctx, executor } = await boot()
    expect(ctx.mcpServers.system()).toEqual([])
    expect(ctx.mcpServers.effective('user-1')).toEqual([])
    expect(executor.schemas()).toEqual(['dsh_system'])
  })

  it('opens both registry units', async () => {
    const { executor } = await boot()
    expect(executor.units()).toEqual(expect.arrayContaining(['mcp_system_servers', 'mcp_user_servers']))
  })

  it('stores the administrator list as one revisioned global document', async () => {
    const executor = new RegistryExecutor()
    const { ctx } = await boot(executor)
    await ctx.mcpServers.upsertSystem(input())

    const insert = executor.calls.find(call => call.text.startsWith('INSERT') && call.text.includes('dsh_system.kv_case_global'))
    expect(insert, 'routes the write to the system schema global singleton').toBeDefined()
    expect(insert!.values?.[0]).toBe('mcp_system_servers')
    expect(JSON.parse(String(insert!.values?.[1]))).toEqual({
      revision: 1,
      servers: [{
        serverName: 'acme-tools',
        url: 'https://mcp.acme.example/rpc',
        headers: {},
        enabled: true,
        updatedAt: expect.any(String) as unknown,
      }],
    })
    expect(executor.schemas()).toEqual(['dsh_system'])
  })

  it('stores a user list as one record keyed by user id', async () => {
    const executor = new RegistryExecutor()
    const { ctx } = await boot(executor)
    await ctx.mcpServers.upsertUser('user-1', input({ serverName: 'mine' }))

    const insert = executor.calls.find(call => call.text.startsWith('INSERT') && call.text.includes('dsh_system.kv_case_record'))
    expect(insert, 'routes the write to the system schema record table').toBeDefined()
    expect(insert!.values?.[0]).toBe('mcp_user_servers')
    expect(insert!.values?.[1]).toBe('server')
    expect(insert!.values?.[2]).toBe('user-1')
    expect(JSON.parse(String(insert!.values?.[3]))).toEqual({
      revision: 1,
      servers: [{
        serverName: 'mine',
        url: 'https://mcp.acme.example/rpc',
        headers: {},
        enabled: true,
        updatedAt: expect.any(String) as unknown,
      }],
    })
    expect(executor.schemas()).toEqual(['dsh_system'])
  })

  it('serves the same registries to a second process reading the same medium', async () => {
    const executor = new RegistryExecutor()
    const first = await boot(executor)
    await first.ctx.mcpServers.upsertSystem(input())
    await first.ctx.mcpServers.upsertUser('user-1', input({ serverName: 'mine' }))
    const systemStamp = first.ctx.mcpServers.system()[0]!.updatedAt

    const second = await boot(executor)
    expect(second.ctx.mcpServers.system().map((row: ExternalMcpServerRecord) => row.serverName)).toEqual(['acme-tools'])
    expect(second.ctx.mcpServers.system()[0]!.updatedAt).toBe(systemStamp)
    expect(second.ctx.mcpServers.revision()).toBe(1)
    expect(second.ctx.mcpServers.effective('user-1').map(entry => entry.serverName)).toEqual(['acme-tools', 'mine'])
  })

  it('keeps two users’ registers apart on the medium', async () => {
    const executor = new RegistryExecutor()
    const first = await boot(executor)
    await first.ctx.mcpServers.upsertUser('user-1', input({ serverName: 'mine' }))
    await first.ctx.mcpServers.upsertUser('user-2', input({ serverName: 'theirs' }))

    const second = await boot(executor)
    expect(second.ctx.mcpServers.effective('user-1').map(entry => entry.serverName)).toEqual(['mine'])
    expect(second.ctx.mcpServers.effective('user-2').map(entry => entry.serverName)).toEqual(['theirs'])
    expect(second.ctx.mcpServers.effective('user-3')).toEqual([])
  })

  it('notifies listeners after the write reached the medium', async () => {
    const { ctx } = await boot()
    const listener = vi.fn()
    ctx.mcpServers.subscribe(listener)
    await ctx.mcpServers.upsertUser('user-1', input())
    expect(listener).toHaveBeenCalledTimes(1)
    await ctx.mcpServers.removeUser('user-1', 'acme-tools')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('refuses a write whose expected revision the medium moved past', async () => {
    const { ctx } = await boot()
    await ctx.mcpServers.upsertSystem(input())
    await expect(ctx.mcpServers.upsertSystem(input({ descr: 'stale' }), { expectedRevision: 0 }))
      .rejects.toThrow(McpServerRevisionConflict)
  })

  it('applies the configured quotas', async () => {
    const { ctx } = await boot(undefined, { maxUserServers: 1 })
    await ctx.mcpServers.upsertUser('user-1', input({ serverName: 'one' }))
    await expect(ctx.mcpServers.upsertUser('user-1', input({ serverName: 'two' }))).rejects.toThrow(/at most 1 servers/)
  })

  it('fails loudly at activation when the medium holds a row it cannot mount', async () => {
    const executor = new RegistryExecutor()
    executor.seedGlobal('dsh_system', 'mcp_system_servers', {
      revision: 1,
      servers: [{ serverName: 'broken', url: 'https://acme.example/rpc', command: 'npx' }],
    })
    await expect(boot(executor)).rejects.toThrow(/only Streamable HTTP servers/)
  })

  it('re-reads the medium on every write rather than trusting its cache', async () => {
    const executor = new RegistryExecutor()
    const { ctx } = await boot(executor)
    // Another process registers a server between this store's reads.
    executor.seedGlobal('dsh_system', 'mcp_system_servers', {
      revision: 7,
      servers: [{ serverName: 'external', url: 'https://other.example/rpc', headers: {}, enabled: true, updatedAt: '2026-02-03T04:05:06.000Z' }],
    })
    await ctx.mcpServers.upsertUser('user-1', input({ serverName: 'mine' }))
    expect(ctx.mcpServers.effective('user-1').map(entry => entry.serverName)).toEqual(['mine'])

    await ctx.mcpServers.upsertSystem(input({ serverName: 'second' }))
    expect(ctx.mcpServers.system().map(row => row.serverName)).toEqual(['external', 'second'])
    expect(ctx.mcpServers.revision()).toBe(8)
  })

  it('reads back a user row an intranet endpoint was allowed to store', async () => {
    // A deployment that serves an intranet MCP server (`allowPrivateHosts: true`)
    // must also be able to read the row it just accepted: the user register is
    // re-parsed from the medium on every read, and a read that applies a stricter
    // address policy than the write turns a successful save into a register that
    // can never be listed, tested, removed, or mounted again.
    const executor = new RegistryExecutor()
    const intranet = { serverName: 'intranet', url: 'http://mcp.internal.svc.cluster.local:19830/mcp/tools' }
    const first = await boot(executor, { allowPrivateHosts: true })
    await first.ctx.mcpServers.upsertUser('user-1', intranet)
    expect(first.ctx.mcpServers.user('user-1').map(row => row.serverName)).toEqual(['intranet'])

    const second = await boot(executor, { allowPrivateHosts: true })
    expect(second.ctx.mcpServers.user('user-1').map(row => row.serverName)).toEqual(['intranet'])
    expect(second.ctx.mcpServers.effective('user-1').map(entry => entry.serverName)).toEqual(['intranet'])
    await expect(second.ctx.mcpServers.removeUser('user-1', 'intranet')).resolves.toBeUndefined()
    expect(second.ctx.mcpServers.user('user-1')).toEqual([])
  })

  it('still refuses an intranet row when the deployment allows public endpoints only', async () => {
    const { ctx } = await boot(undefined, { allowPrivateHosts: false })
    await expect(ctx.mcpServers.upsertUser('user-1', { serverName: 'intranet', url: 'http://10.0.0.5:8080/mcp' }))
      .rejects.toThrow(/loopback, private/)
  })
})
