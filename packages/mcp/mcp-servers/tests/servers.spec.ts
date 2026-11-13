// The external MCP server registry: every rule that decides what may be stored,
// and the base store's behaviour over a provider, exercised on an in-memory
// medium so the medium's own concerns stay out of the way.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  McpServerRevisionConflict,
  McpServerStore,
  effectiveServers,
  isBlockedHost,
  mountNameFor,
  parseConcurrency,
  parseHeaders,
  parseServerList,
  parseServerRecord,
  parseStoredList,
  serverNameBudget,
  sortRecords,
  userMountPrefix,
} from '../src/index.ts'
import type { ExternalMcpServerRecord, StoredRegistry } from '../src/index.ts'

/** A stored-shaped row, valid as an input once `updatedAt` is dropped. */
function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { serverName: 'acme-tools', url: 'https://mcp.acme.example/rpc', ...overrides }
}

/** A row as a medium returns it. */
function stored(overrides: Partial<ExternalMcpServerRecord> = {}): ExternalMcpServerRecord {
  return {
    serverName: 'acme-tools',
    url: 'https://mcp.acme.example/rpc',
    headers: {},
    enabled: true,
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  }
}

/** A provider whose medium is two arrays, so the base class is what is under test. */
class MemoryStore extends McpServerStore {
  systemRecords: ExternalMcpServerRecord[] = []
  userRecords = new Map<string, ExternalMcpServerRecord[]>()
  revisionCount = 0
  readonlyMedium = false

  override get writable(): boolean {
    return !this.readonlyMedium
  }

  override revision(): number {
    return this.revisionCount
  }

  protected override snapshotSystem(): readonly ExternalMcpServerRecord[] {
    return this.systemRecords
  }

  protected override snapshotUser(userId: string): readonly ExternalMcpServerRecord[] {
    return this.userRecords.get(userId) ?? []
  }

  protected override async loadSystem(): Promise<StoredRegistry> {
    return { records: this.systemRecords, revision: this.revisionCount }
  }

  protected override async loadUser(userId: string): Promise<StoredRegistry> {
    return { records: this.userRecords.get(userId) ?? [], revision: 0 }
  }

  protected override async writeSystem(
    records: readonly ExternalMcpServerRecord[],
    expectedRevision?: number,
  ): Promise<number> {
    if (expectedRevision !== undefined && expectedRevision !== this.revisionCount) {
      throw new McpServerRevisionConflict(expectedRevision, this.revisionCount)
    }
    this.systemRecords = [...records]
    this.revisionCount += 1
    return this.revisionCount
  }

  protected override async writeUser(userId: string, records: readonly ExternalMcpServerRecord[]): Promise<void> {
    this.userRecords.set(userId, [...records])
  }

  protected override now(): string {
    return '2026-11-11T00:00:00.000Z'
  }
}

/** Fibers opened by a test, disposed after it. */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Boot one store over the in-memory medium. */
async function boot(limits: Record<string, unknown> = {}): Promise<MemoryStore> {
  const ctx = new Context()
  const fiber = ctx.plugin(MemoryStore, limits)
  cleanups.push(async () => {
    await fiber.dispose()
  })
  await fiber
  return ctx.mcpServers as MemoryStore
}

describe('parseServerRecord', () => {
  it('normalises defaults and drops an empty description', () => {
    expect(parseServerRecord(input(), 'row')).toEqual({
      serverName: 'acme-tools',
      url: 'https://mcp.acme.example/rpc',
      headers: {},
      enabled: true,
    })
    expect(parseServerRecord(input({ descr: '' }), 'row')).not.toHaveProperty('descr')
  })

  it('keeps the optional fields it was given', () => {
    expect(parseServerRecord(input({
      timeoutMs: 15_000,
      headers: { Authorization: 'Bearer t' },
      descr: 'Acme tools',
      toolConcurrency: { policy: 'exclusive', maxConcurrentCalls: 1 },
    }), 'row')).toEqual({
      serverName: 'acme-tools',
      url: 'https://mcp.acme.example/rpc',
      headers: { Authorization: 'Bearer t' },
      timeoutMs: 15_000,
      toolConcurrency: { policy: 'exclusive', maxConcurrentCalls: 1 },
      enabled: true,
      descr: 'Acme tools',
    })
  })

  it.each(['command', 'args', 'cwd', 'env', 'transport'])('refuses the stdio field %s', (field) => {
    expect(() => parseServerRecord(input({ [field]: 'x' }), 'row')).toThrow(/only Streamable HTTP servers/)
  })

  it('refuses a non-object row', () => {
    expect(() => parseServerRecord(null, 'row')).toThrow(/must be an object/)
    expect(() => parseServerRecord([], 'row')).toThrow(/must be an object/)
  })

  it('refuses a name the tool namespace cannot carry', () => {
    expect(() => parseServerRecord(input({ serverName: 'has space' }), 'row')).toThrow(/serverName/)
    expect(() => parseServerRecord(input({ serverName: '' }), 'row')).toThrow(/non-empty string/)
    expect(() => parseServerRecord(input({ serverName: 'a'.repeat(33) }), 'row')).toThrow(/serverName/)
  })

  it('refuses a URL that is not absolute http(s)', () => {
    expect(() => parseServerRecord(input({ url: '/relative' }), 'row')).toThrow(/absolute URL/)
    expect(() => parseServerRecord(input({ url: 'ftp://acme.example/x' }), 'row')).toThrow(/http or https/)
  })

  it('refuses an untrusted host that is loopback, private, or metadata', () => {
    expect(() => parseServerRecord(input({ url: 'http://127.0.0.1:9000/mcp' }), 'row'))
      .toThrow(/loopback, private, link-local, or metadata/)
    expect(() => parseServerRecord(input({ url: 'http://169.254.169.254/latest/meta-data' }), 'row'))
      .toThrow(/loopback, private/)
  })

  it('accepts such a host only when the caller is trusted', () => {
    expect(parseServerRecord(input({ url: 'http://10.0.0.5:9000/mcp' }), 'row', { allowPrivateHosts: true }).url)
      .toBe('http://10.0.0.5:9000/mcp')
  })

  it('refuses out-of-range option values', () => {
    expect(() => parseServerRecord(input({ timeoutMs: 0 }), 'row')).toThrow(/timeoutMs/)
    expect(() => parseServerRecord(input({ timeoutMs: 600_001 }), 'row')).toThrow(/timeoutMs/)
    expect(() => parseServerRecord(input({ timeoutMs: 1.5 }), 'row')).toThrow(/timeoutMs/)
    expect(() => parseServerRecord(input({ enabled: 'yes' }), 'row')).toThrow(/enabled/)
    expect(() => parseServerRecord(input({ descr: 7 }), 'row')).toThrow(/descr/)
  })
})

describe('parseHeaders', () => {
  it('treats an absent map as empty', () => {
    expect(parseHeaders(undefined, 'row')).toEqual({})
  })

  it('refuses a non-object and a non-string value', () => {
    expect(() => parseHeaders([], 'row')).toThrow(/must be an object of string values/)
    expect(() => parseHeaders({ A: 1 }, 'row')).toThrow(/header "A" must be a string/)
    expect(() => parseHeaders({ '': 'v' }, 'row')).toThrow(/non-empty/)
  })
})

describe('parseConcurrency', () => {
  it('keeps only the operator-owned subset', () => {
    expect(parseConcurrency({ policy: 'parallel', maxConcurrentCalls: 4 }, 'row'))
      .toEqual({ policy: 'parallel', maxConcurrentCalls: 4 })
    expect(parseConcurrency({ exclusiveTools: ['slow'] }, 'row')).toEqual({ exclusiveTools: ['slow'] })
    expect(parseConcurrency({}, 'row')).toBeUndefined()
    expect(parseConcurrency(undefined, 'row')).toBeUndefined()
  })

  it('refuses a value outside the subset', () => {
    expect(() => parseConcurrency({ policy: 'adaptive' }, 'row')).toThrow(/policy/)
    expect(() => parseConcurrency({ maxConcurrentCalls: 0 }, 'row')).toThrow(/maxConcurrentCalls/)
    expect(() => parseConcurrency({ maxConcurrentCalls: 2048 }, 'row')).toThrow(/maxConcurrentCalls/)
    expect(() => parseConcurrency({ exclusiveTools: [1] }, 'row')).toThrow(/exclusiveTools/)
    expect(() => parseConcurrency('nope', 'row')).toThrow(/must be an object/)
  })
})

describe('parseServerList', () => {
  it('treats an absent list as empty and keeps order', () => {
    expect(parseServerList(undefined, 'list')).toEqual([])
    const list = parseServerList([input(), input({ serverName: 'beta' })], 'list')
    expect(list.map(entry => entry.serverName)).toEqual(['acme-tools', 'beta'])
  })

  it('refuses a non-array and a duplicate name', () => {
    expect(() => parseServerList({}, 'list')).toThrow(/must be an array/)
    expect(() => parseServerList([input(), input()], 'list')).toThrow(/duplicate serverName/)
  })

  it('names the offending index', () => {
    expect(() => parseServerList([input(), input({ serverName: 'bad name' })], 'list')).toThrow(/list\[1\]/)
  })
})

describe('parseStoredList', () => {
  it('keeps the timestamp the medium stored', () => {
    expect(parseStoredList([{ ...input(), updatedAt: '2026-01-02T03:04:05.000Z' }], 'list'))
      .toEqual([stored({ updatedAt: '2026-01-02T03:04:05.000Z' })])
  })

  it('falls back to the epoch when a row carries no timestamp', () => {
    expect(parseStoredList([input()], 'list')[0]!.updatedAt).toBe(new Date(0).toISOString())
  })

  it('re-validates a hand-edited document', () => {
    expect(() => parseStoredList([input({ command: 'npx' })], 'list')).toThrow(/only Streamable HTTP servers/)
  })
})

describe('isBlockedHost', () => {
  it.each([
    'localhost',
    'app.localhost',
    'printer.local',
    'metadata.google.internal',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '[::1]',
    '[fd00::1]',
    '[fe80::1]',
    '[::ffff:127.0.0.1]',
  ])('blocks %s', (host) => {
    expect(isBlockedHost(host)).toBe(true)
  })

  it.each(['mcp.acme.example', '8.8.8.8', '[2001:4860:4860::8888]'])('allows %s', (host) => {
    expect(isBlockedHost(host)).toBe(false)
  })

  it('blocks a malformed dotted quad rather than reading it as a hostname', () => {
    expect(isBlockedHost('999.1.1.1')).toBe(true)
  })
})

describe('mount names', () => {
  it('keeps the system name verbatim and prefixes a user row with its owner digest', () => {
    expect(mountNameFor('system', 'icac-bill')).toBe('icac-bill')
    const prefix = userMountPrefix('user-1')
    expect(prefix).toMatch(/^u_[0-9a-f]{8}__$/)
    expect(mountNameFor('user', 'acme', 'user-1')).toBe(`${prefix}acme`)
  })

  it('gives different owners different prefixes and the same owner a stable one', () => {
    expect(userMountPrefix('user-1')).toBe(userMountPrefix('user-1'))
    expect(userMountPrefix('user-1')).not.toBe(userMountPrefix('user-2'))
  })

  it('budgets the owner prefix out of the namespace', () => {
    expect(serverNameBudget('system')).toBe(32)
    expect(serverNameBudget('user', 'user-1')).toBe(32 - userMountPrefix('user-1').length)
    expect(() => serverNameBudget('user')).toThrow(/needs an owner/)
    expect(() => mountNameFor('user', 'acme')).toThrow(/needs an owner/)
  })
})

describe('effectiveServers', () => {
  it('unions the registries, dropping disabled rows and labelling the origin', () => {
    const system = [stored({ serverName: 'zeta' }), stored({ serverName: 'alpha', enabled: false })]
    const mine = [stored({ serverName: 'mine' }), stored({ serverName: 'off', enabled: false })]
    const effective = effectiveServers(system, mine, 'user-1')
    expect(effective.map(entry => [entry.origin, entry.serverName, entry.mountName, entry.ownerId])).toEqual([
      ['system', 'zeta', 'zeta', undefined],
      ['user', 'mine', mountNameFor('user', 'mine', 'user-1'), 'user-1'],
    ])
  })

  it('orders each registry by name', () => {
    const effective = effectiveServers([stored({ serverName: 'b' }), stored({ serverName: 'a' })], [], 'user-1')
    expect(effective.map(entry => entry.serverName)).toEqual(['a', 'b'])
  })
})

describe('sortRecords', () => {
  it('sorts by server name without mutating the input', () => {
    const rows = [stored({ serverName: 'b' }), stored({ serverName: 'a' })]
    expect(sortRecords(rows).map(row => row.serverName)).toEqual(['a', 'b'])
    expect(rows.map(row => row.serverName)).toEqual(['b', 'a'])
  })
})

describe('McpServerStore', () => {
  it('starts empty and reports an empty effective set', async () => {
    const store = await boot()
    expect(store.system()).toEqual([])
    expect(store.effective('user-1')).toEqual([])
    expect(store.describe('user-1')).toEqual({ system: [], user: [], effective: [], revision: 0 })
  })

  it('adds, replaces, and removes a system row, stamping and notifying each change', async () => {
    const store = await boot()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.upsertSystem(input())
    expect(store.system()).toEqual([stored()])
    expect(store.revision()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)

    await store.upsertSystem(input({ descr: 'renamed' }))
    expect(store.system()).toHaveLength(1)
    expect(store.system()[0]!.descr).toBe('renamed')
    expect(store.revision()).toBe(2)

    await store.removeSystem('acme-tools')
    expect(store.system()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('does not notify for a removal that changed nothing', async () => {
    const store = await boot()
    const listener = vi.fn()
    store.subscribe(listener)
    await store.removeSystem('absent')
    await store.removeUser('user-1', 'absent')
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying a listener that unsubscribed', async () => {
    const store = await boot()
    const listener = vi.fn()
    const remove = store.subscribe(listener)
    remove()
    await store.upsertSystem(input())
    expect(listener).not.toHaveBeenCalled()
  })

  it('refuses a system row that points at a host an operator cannot reach on purpose', async () => {
    const store = await boot({ allowPrivateHosts: false })
    await expect(store.upsertSystem(input({ url: 'http://10.0.0.5:9000/mcp' }))).rejects.toThrow(/loopback, private/)
  })

  it('enforces the system quota', async () => {
    const store = await boot({ maxSystemServers: 1 })
    await store.upsertSystem(input())
    await expect(store.upsertSystem(input({ serverName: 'second' }))).rejects.toThrow(/at most 1 servers/)
  })

  it('replaces a row in place instead of counting it against the quota', async () => {
    const store = await boot({ maxSystemServers: 1 })
    await store.upsertSystem(input())
    await store.upsertSystem(input({ descr: 'again' }))
    expect(store.system()).toHaveLength(1)
  })

  it('keeps one registry per user and unions it with the system registry', async () => {
    const store = await boot()
    await store.upsertSystem(input())
    await store.upsertUser('user-1', input({ serverName: 'mine' }))
    await store.upsertUser('user-2', input({ serverName: 'theirs' }))

    expect(store.user('user-1').map(row => row.serverName)).toEqual(['mine'])
    expect(store.user('user-2').map(row => row.serverName)).toEqual(['theirs'])
    expect(store.effective('user-1').map(entry => entry.serverName)).toEqual(['acme-tools', 'mine'])
    expect(store.effective('user-2').map(entry => entry.serverName)).toEqual(['acme-tools', 'theirs'])
  })

  it('keeps a user row global across that user’s cases and invisible to another user', async () => {
    const store = await boot()
    await store.upsertUser('user-1', input({ serverName: 'mine' }))
    expect(store.effective('user-1')).toHaveLength(1)
    expect(store.effective('user-3')).toEqual([])
  })

  it('applies one address policy to both registers', async () => {
    // Whoever configures a server is the one who will use it, so a user row is
    // held to the same host policy as a system row — including the permissive
    // default that lets an intranet endpoint be stored at all.
    const permissive = await boot({ allowPrivateHosts: true })
    await expect(permissive.upsertUser('user-1', input({ url: 'http://192.168.0.10/mcp' }))).resolves.toBeUndefined()

    // …and an operator who needs public-only endpoints gets that for users too.
    const strict = await boot({ allowPrivateHosts: false })
    await expect(strict.upsertUser('user-1', input({ url: 'http://192.168.0.10/mcp' }))).rejects.toThrow(/loopback, private/)
  })

  it('refuses a user row whose name would not fit the prefixed namespace', async () => {
    const store = await boot()
    const budget = serverNameBudget('user', 'user-1')
    await expect(store.upsertUser('user-1', input({ serverName: 'x'.repeat(budget + 1) })))
      .rejects.toThrow(/too long for a user row/)
    await store.upsertUser('user-1', input({ serverName: 'x'.repeat(budget) }))
    expect(store.user('user-1')).toHaveLength(1)
  })

  it('enforces the per-user quota', async () => {
    const store = await boot({ maxUserServers: 1 })
    await store.upsertUser('user-1', input({ serverName: 'one' }))
    await expect(store.upsertUser('user-1', input({ serverName: 'two' }))).rejects.toThrow(/at most 1 servers/)
    await store.upsertUser('user-2', input({ serverName: 'two' }))
    expect(store.user('user-2')).toHaveLength(1)
  })

  it('refuses a user row without an owner', async () => {
    const store = await boot()
    await expect(store.upsertUser('  ', input())).rejects.toThrow(/needs an owner/)
  })

  it('rejects a write whose expected revision the medium moved past', async () => {
    const store = await boot()
    await store.upsertSystem(input())
    await expect(store.upsertSystem(input({ descr: 'stale' }), { expectedRevision: 0 }))
      .rejects.toThrow(McpServerRevisionConflict)
  })

  it('removes a user row and reports the remaining ones', async () => {
    const store = await boot()
    await store.upsertUser('user-1', input({ serverName: 'a' }))
    await store.upsertUser('user-1', input({ serverName: 'b' }))
    await store.removeUser('user-1', 'a')
    expect(store.user('user-1').map(row => row.serverName)).toEqual(['b'])
  })

  it('refuses every write on a read-only provider', async () => {
    const store = await boot()
    store.readonlyMedium = true
    await expect(store.upsertSystem(input())).rejects.toThrow(/read-only/)
    await expect(store.removeSystem('a')).rejects.toThrow(/read-only/)
    await expect(store.upsertUser('user-1', input())).rejects.toThrow(/read-only/)
    await expect(store.removeUser('user-1', 'a')).rejects.toThrow(/read-only/)
  })

  it('notifies a listener registered after an earlier change only for later changes', async () => {
    const store = await boot()
    await store.upsertSystem(input())
    const listener = vi.fn()
    store.subscribe(listener)
    await store.upsertSystem(input({ descr: 'later' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
