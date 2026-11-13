/**
 * The configuration seed for the external MCP registry: rows from the deployment
 * file become the initial system list only while that list is empty, so a server
 * an administrator deleted is never resurrected by a leftover configuration entry.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpServerStore, sortRecords } from '@deepseek-ai/dsh-mcp-servers'
import type { ExternalMcpServerRecord, StoredRegistry } from '@deepseek-ai/dsh-mcp-servers'
import { seedSystemServers } from '../src/mcp-external.ts'

/** In-memory registry: the medium is not what the seed is about. */
class MemoryMcpServerStore extends McpServerStore {
  private records: readonly ExternalMcpServerRecord[] = []
  private readonly users = new Map<string, ExternalMcpServerRecord[]>()
  private current = 0

  override revision(): number {
    return this.current
  }

  protected override async loadSystem(): Promise<StoredRegistry> {
    return { records: this.records, revision: this.current }
  }

  protected override async loadUser(userId: string): Promise<StoredRegistry> {
    return { records: this.users.get(userId) ?? [], revision: 0 }
  }

  protected override async writeSystem(records: readonly ExternalMcpServerRecord[]): Promise<number> {
    this.records = sortRecords(records)
    this.current += 1
    return this.current
  }

  protected override async writeUser(userId: string, records: readonly ExternalMcpServerRecord[]): Promise<void> {
    this.users.set(userId, sortRecords(records))
  }

  protected override snapshotSystem(): readonly ExternalMcpServerRecord[] {
    return this.records
  }

  protected override snapshotUser(userId: string): readonly ExternalMcpServerRecord[] {
    return this.users.get(userId) ?? []
  }
}

/** Boot a bare context, optionally with a registry mounted. */
async function boot(options?: { registry?: boolean; allowPrivateHosts?: boolean }): Promise<Context> {
  const ctx = new Context()
  if (options?.registry !== false) {
    await ctx.plugin(MemoryMcpServerStore, { allowPrivateHosts: options?.allowPrivateHosts ?? true })
  }
  return ctx
}

describe('seedSystemServers', () => {
  it('writes every configured server into an empty register', async () => {
    const ctx = await boot()
    await seedSystemServers(ctx, [
      {
        serverName: 'docs',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer t' },
      },
      { serverName: 'wiki', transport: 'streamable-http', url: 'https://wiki.example.com/mcp', toolCallTimeoutMs: 30_000 },
    ])
    const store = ctx.get('mcpServers')
    expect(store?.system().map(row => row.serverName)).toEqual(['docs', 'wiki'])
    expect(store?.system()[0]).toMatchObject({
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      enabled: true,
    })
    // The configuration spells the timeout its own way; the record keeps one name.
    expect(store?.system()[1]?.timeoutMs).toBe(30_000)
    expect(store?.system()[1]?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/u)
  })

  it('leaves a register that already has rows untouched', async () => {
    const ctx = await boot()
    const store = ctx.get('mcpServers')
    await store?.upsertSystem({ serverName: 'kept', url: 'https://kept.example.com/mcp', enabled: true })
    const before = store?.revision()
    await seedSystemServers(ctx, [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }])
    expect(store?.system().map(row => row.serverName)).toEqual(['kept'])
    expect(store?.revision()).toBe(before)
  })

  it('refuses to run without a registry instead of silently dropping the seed', async () => {
    const ctx = await boot({ registry: false })
    await expect(seedSystemServers(ctx, [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example.com/mcp' }]))
      .rejects.toThrow(/注册表没有起来/u)
  })

  it('names the offending configuration row when the registry rejects it', async () => {
    // The policy here is the one a user-facing register uses: an intranet endpoint
    // is refused, so a stale configuration entry fails the boot instead of
    // silently disappearing.
    const ctx = await boot({ allowPrivateHosts: false })
    await expect(seedSystemServers(ctx, [{ serverName: 'docs', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }]))
      .rejects.toThrow(/127\.0\.0\.1/u)
    await expect(seedSystemServers(ctx, [{ serverName: 'docs', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }]))
      .rejects.toThrow(/"docs"/u)
  })
})
