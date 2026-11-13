/**
 * External MCP server routes over the registry: both registers read and write
 * through one medium, a write reports the row back with its headers reduced to
 * names, the user methods take their owner from the ambient partition rather
 * than the payload, and a deployment without a registry refuses writes instead
 * of pretending to store them.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { McpServerRevisionConflict, McpServerStore, sortRecords } from '@deepseek-ai/dsh-mcp-servers'
import type { ExternalMcpServerRecord, StoredRegistry } from '@deepseek-ai/dsh-mcp-servers'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy, resolveMcpProbeTarget } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

let nextRpc = 1
/** One wire request carrying the given payload. */
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('req-' + String(nextRpc++)), payload }
}

/** Unwrap an ok reply, failing the test on an error reply. */
function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

/** Unwrap an error reply, failing the test on an ok reply. */
function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** In-memory registry: the medium is not what these routes are about. */
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

  protected override async writeSystem(records: readonly ExternalMcpServerRecord[], expectedRevision?: number): Promise<number> {
    if (expectedRevision !== undefined && expectedRevision !== this.current) {
      throw new McpServerRevisionConflict(expectedRevision, this.current)
    }
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

/**
 * The subject whose request is in flight. A partitioned deployment derives this
 * from the request the carrier authenticated; here the fake provider below is
 * that deployment, so a test says "this call arrives as user-1" by setting it.
 */
let ambientUser: string | undefined

/** Boot the proxy over the host seams and, optionally, an MCP registry. */
async function boot(options?: { registry?: boolean }): Promise<{ ctx: Context; api: ReturnType<typeof createApiProxy> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  ctx.provide('workspaceRegistry', { list: () => [], ensureLoaded: async () => {} } as never)
  // A per-user deployment: the seam is what makes `My` routes resolvable at all.
  ctx.provide('partitionScope', {
    current: () => ambientUser === undefined
      ? undefined
      : {
        tenant: 'case-1',
        user: ambientUser,
        tenantName: 'case_1',
        userName: ambientUser,
        dataRoot: '/tmp/case-1',
      },
  })
  if (options?.registry !== false) await ctx.plugin(MemoryMcpServerStore)
  return { ctx, api: createApiProxy(ctx, DEFAULTS) }
}

/** Run a call as one user's request, as a partitioned carrier would. */
async function asUser<T>(userId: string, run: () => Promise<T>): Promise<T> {
  ambientUser = userId
  try {
    return await run()
  } finally {
    ambientUser = undefined
  }
}

describe('external MCP server routes', () => {
  it('stores a system server and reports it with header names instead of values', async () => {
    const { api } = await boot()
    const value = expectOk(await api.mcp.saveServer(request({
      serverName: 'docs',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer sk-secret', 'X-Tenant': 'acme' },
      descr: 'Documentation search',
    })))
    expect(value.servers).toHaveLength(1)
    const [row] = value.servers
    expect(row).toMatchObject({
      serverName: 'docs',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      descr: 'Documentation search',
      origin: 'system',
      mountName: 'docs',
      headerNames: ['Authorization', 'X-Tenant'],
      hasAuthorization: true,
    })
    // The one thing a view must never carry: the stored credential is not sent to
    // a browser, so a form cannot leak it and a list row cannot show it.
    expect(JSON.stringify(value)).not.toContain('sk-secret')
    expect(value.revision).toBeGreaterThan(0)
  })

  it('keeps stored headers when an update omits them and clears them when it sends an empty map', async () => {
    const { api } = await boot()
    const write = { serverName: 'docs', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer sk-secret' } }
    expectOk(await api.mcp.saveServer(request(write)))
    const kept = expectOk(await api.mcp.saveServer(request({ serverName: 'docs', url: 'https://mcp.example.com/mcp2' })))
    expect(kept.servers[0]?.headerNames).toEqual(['Authorization'])
    expect(kept.servers[0]?.url).toBe('https://mcp.example.com/mcp2')
    const cleared = expectOk(await api.mcp.saveServer(request({ serverName: 'docs', url: 'https://mcp.example.com/mcp2', headers: {} })))
    expect(cleared.servers[0]?.headerNames).toEqual([])
    expect(cleared.servers[0]?.hasAuthorization).toBe(false)
  })

  it('holds both registers to the same address policy', async () => {
    const { api } = await boot()
    // Whoever configures a server is the one who will use it: an intranet endpoint
    // an administrator may store is an intranet endpoint a user may store.
    expectOk(await api.mcp.saveServer(request({ serverName: 'intranet', url: 'http://10.0.0.5:8080/mcp' })))
    expectOk(await asUser('u1', async () => api.mcp.saveMyServer(request({ serverName: 'mine', url: 'http://10.0.0.5:8080/mcp' }))))
  })

  it('separates the two registers per user and merges them in the effective set', async () => {
    const { api } = await boot()
    expectOk(await api.mcp.saveServer(request({ serverName: 'shared', url: 'https://shared.example.com/mcp' })))
    expectOk(await asUser('u1', async () => api.mcp.saveMyServer(request({ serverName: 'mine', url: 'https://u1.example.com/mcp' }))))
    expectOk(await asUser('u2', async () => api.mcp.saveMyServer(request({ serverName: 'other', url: 'https://u2.example.com/mcp' }))))

    const mine = expectOk(await asUser('u1', async () => api.mcp.myServers(request({}))))
    expect(mine.servers.map(row => row.serverName)).toEqual(['mine'])
    expect(mine.system.map(row => row.serverName)).toEqual(['shared'])
    // A user row mounts under a name derived from its owner, so two users may run
    // identically named servers without shadowing each other.
    expect(mine.servers[0]?.mountName).toMatch(/^u_/u)
    expect(mine.servers[0]?.mountName).toContain('mine')

    const effective = expectOk(await asUser('u2', async () => api.mcp.effectiveServers(request({}))))
    expect(effective.servers.map(row => [row.serverName, row.origin, row.mounted])).toEqual([
      ['shared', 'system', true],
      ['other', 'user', true],
    ])
  })

  it('lists a disabled row as not mounted in the effective set', async () => {
    const { api } = await boot()
    expectOk(await api.mcp.saveServer(request({ serverName: 'off', url: 'https://off.example.com/mcp', enabled: false })))
    const value = expectOk(await api.mcp.effectiveServers(request({})))
    expect(value.servers).toEqual([expect.objectContaining({ serverName: 'off', mounted: false })])
  })

  it('removes a row and reports the register without it', async () => {
    const { api } = await boot()
    expectOk(await api.mcp.saveServer(request({ serverName: 'docs', url: 'https://mcp.example.com/mcp' })))
    const value = expectOk(await api.mcp.removeServer(request({ serverName: 'docs' })))
    expect(value.servers).toEqual([])
  })

  it('refuses a write whose revision has moved', async () => {
    const { api } = await boot()
    const first = expectOk(await api.mcp.saveServer(request({ serverName: 'a', url: 'https://a.example.com/mcp' })))
    expectOk(await api.mcp.saveServer(request({ serverName: 'b', url: 'https://b.example.com/mcp' })))
    const conflict = expectErr(await api.mcp.saveServer(request({
      serverName: 'a', url: 'https://a.example.com/mcp', expectedRevision: first.revision,
    })))
    expect(conflict.code).toBe('mcp-revision-conflict')
    expect(conflict.details).toMatchObject({ serverName: 'a' })
  })

  it('refuses the personal register outside a user scope instead of guessing an owner', async () => {
    const { api } = await boot()
    expect(expectErr(await api.mcp.myServers(request({}))).code).toBe('user-scope-required')
    expect(expectErr(await api.mcp.saveMyServer(request({ serverName: 'mine', url: 'https://u1.example.com/mcp' }))).code)
      .toBe('user-scope-required')
  })

  it('answers an empty register and refuses writes when the deployment mounts no registry', async () => {
    const { api } = await boot({ registry: false })
    expect(expectOk(await api.mcp.systemServers(request({})))).toEqual({ servers: [], revision: 0 })
    expect(expectOk(await api.mcp.effectiveServers(request({})))).toEqual({ servers: [] })
    expect(expectErr(await api.mcp.saveServer(request({ serverName: 'docs', url: 'https://mcp.example.com/mcp' }))).code)
      .toBe('mcp-registry-unavailable')
  })

  it('tests the endpoint a form holds, reporting an unreachable one as an answer', async () => {
    const { api } = await boot()
    const value = expectOk(await api.mcp.testConnection(request({ url: 'http://127.0.0.1:9/mcp', timeoutMs: 500 })))
    expect(value.ok).toBe(false)
    // The deployment's address policy allows an intranet endpoint (the default), so
    // the request was actually sent rather than refused before it left.
    expect(value.addressAllowed).toBe(true)
    expect(typeof value.error).toBe('string')
  })

  it('tests a saved row by name, so a credential need not be sent to a browser', async () => {
    const { api } = await boot()
    expectOk(await asUser('u1', async () => api.mcp.saveMyServer(request({
      serverName: 'mine',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer user-key' },
    }))))

    // No headers in the payload: the host replayed the stored ones against the
    // stored endpoint. A connectivity answer came back instead of a 400.
    const value = expectOk(await asUser('u1', async () => api.mcp.testConnection(request({ serverName: 'mine', timeoutMs: 500 }))))
    expect(value.addressAllowed).toBe(true)
    expect(typeof value.error).toBe('string')
    // The same caller's view of that row still carries no credential value.
    const mine = expectOk(await asUser('u1', async () => api.mcp.myServers(request({}))))
    expect(JSON.stringify(mine)).not.toContain('user-key')
  })

  it('refuses a test that resolves to nothing', async () => {
    const { api } = await boot()
    expect(expectErr(await api.mcp.testConnection(request({ serverName: 'ghost' }))).code).toBe('mcp-server-invalid')
    expect(expectErr(await api.mcp.testConnection(request({}))).code).toBe('mcp-server-invalid')
  })

  it('never echoes the credential back, even when the endpoint repeats it', async () => {
    const { api } = await boot()
    // `127.0.0.1:9` refuses the connection; the header value travels with the test,
    // so if any path echoed it the response or a log line would carry it.
    const secret = 'Bearer sk-live-0123456789'
    const value = expectOk(await api.mcp.testConnection(request({
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: secret },
      timeoutMs: 500,
    })))
    expect(JSON.stringify(value)).not.toContain('sk-live-0123456789')
  })
})

describe('probe target resolution', () => {
  const saved: ExternalMcpServerRecord[] = [{
    serverName: 'docs',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer sk-secret' },
    enabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]

  it('replays a stored credential only against the endpoint it was stored for', () => {
    // Testing what is stored does not require re-typing a secret the views hide…
    expect(resolveMcpProbeTarget({ serverName: 'docs' }, saved).headers).toEqual({ Authorization: 'Bearer sk-secret' })
    // …but the secret is not carried to a different host, which would let a caller
    // redirect a credential they cannot read.
    expect(resolveMcpProbeTarget({ serverName: 'docs', url: 'https://elsewhere.example/mcp' }, saved).headers).toEqual({})
    expect(resolveMcpProbeTarget({ serverName: 'docs', headers: { Authorization: 'Bearer other' } }, saved).headers)
      .toEqual({ Authorization: 'Bearer other' })
  })

  it('uses the payload endpoint when it names no saved row', () => {
    expect(resolveMcpProbeTarget({ url: 'https://draft.example/mcp', timeoutMs: 10 }, saved))
      .toEqual({ url: 'https://draft.example/mcp', headers: {}, timeoutMs: 10 })
  })
})
