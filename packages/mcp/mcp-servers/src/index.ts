/**
 * Service Definition for the external MCP server registry: two registries — one
 * deployment-wide `system` list an administrator owns, and one list per user —
 * whose union is what a session of that user mounts. The store owns validation,
 * quotas, and the change signal; a provider owns the medium.
 *
 * The split between the two registries is the whole authorisation model: a
 * `system` row is mounted for everyone, a `user` row only for its owner, and the
 * effective list is derived here rather than stored, so a caller cannot read a
 * row that belongs to someone else without naming that user.
 * @module @deepseek-ai/dsh-mcp-servers
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { mountNameFor, serverNameBudget } from './naming.ts'
import type { EffectiveMcpServer, ExternalMcpServerRecord, McpServerLimits, McpServerOrigin } from './types.ts'
import { parseServerRecord } from './validate.ts'

export type * from './types.ts'
export { mountNameFor, serverNameBudget, userMountPrefix } from './naming.ts'
export { isBlockedHost, parseConcurrency, parseHeaders, parseServerList, parseServerRecord, parseStoredList } from './validate.ts'

/** What a provider hands back when it loads one registry. */
export interface StoredRegistry {
  /** Rows in the medium, `updatedAt` included. */
  records: readonly ExternalMcpServerRecord[]
  /** Monotonic write counter of the medium, for optimistic concurrency. */
  revision: number
}

/** A conflict between the expected and the stored revision of the system registry. */
export class McpServerRevisionConflict extends Error {
  /**
   * @param expected - revision the writer read.
   * @param actual - revision the medium holds.
   */
  constructor(expected: number, actual: number) {
    super(`mcp-servers: system registry changed (expected revision ${String(expected)}, found ${String(actual)})`)
    this.name = 'McpServerRevisionConflict'
    this.expected = expected
    this.actual = actual
  }

  /** Revision the writer read. */
  readonly expected: number

  /** Revision the medium holds. */
  readonly actual: number
}

/**
 * Stable identity of a row, used for ordering and for replace-in-place updates.
 * @param record - stored row.
 * @returns the row's server name.
 */
export function serverKey(record: ExternalMcpServerRecord): string {
  return record.serverName
}

/**
 * Order one registry so a stored list, a cached list, and a rendered list are
 * the same sequence and a no-op write reports no change.
 * @param records - rows to order.
 * @returns the same rows sorted by server name.
 */
export function sortRecords(records: readonly ExternalMcpServerRecord[]): ExternalMcpServerRecord[] {
  return [...records].sort((left, right) => serverKey(left).localeCompare(serverKey(right)))
}

/**
 * Derive the effective set for one user: every enabled `system` row plus every
 * enabled row that user owns, each carrying the registry it came from and the
 * name it mounts under. Disabled rows are dropped here rather than at mount
 * time, so the effective list a caller reads is exactly what a session gets.
 * @param system - the system registry.
 * @param mine - the user's own registry.
 * @param userId - the owner whose rows are included.
 * @returns the effective servers, system first, each registry sorted by name.
 */
export function effectiveServers(
  system: readonly ExternalMcpServerRecord[],
  mine: readonly ExternalMcpServerRecord[],
  userId: string,
): EffectiveMcpServer[] {
  const enabled = (row: ExternalMcpServerRecord): boolean => row.enabled
  const fromSystem = sortRecords(system).filter(enabled)
    .map((row): EffectiveMcpServer => ({ ...row, origin: 'system', mountName: mountNameFor('system', row.serverName) }))
  const fromUser = sortRecords(mine).filter(enabled)
    .map((row): EffectiveMcpServer => ({ ...row, origin: 'user', ownerId: userId, mountName: mountNameFor('user', row.serverName, userId) }))
  return [...fromSystem, ...fromUser]
}

/**
 * The external MCP server registry.
 *
 * Providers implement the four medium primitives; every rule that decides what
 * may be stored lives here, so both registries reject the same malformed row on
 * both sides and a second provider cannot weaken validation by accident.
 */
export abstract class McpServerStore extends Service {
  /**
   * @param ctx - Cordis context owning the store.
   * @param limits - quotas and host policy enforced on every write.
   */
  constructor(ctx: Context, limits: McpServerLimits = {}) {
    super(ctx, 'mcpServers')
    this.limits = limits
  }

  /** Quotas and host policy this store enforces. */
  protected readonly limits: McpServerLimits

  /** Whether the medium accepts writes (a read-only provider reports false). */
  get writable(): boolean {
    return true
  }

  /**
   * Whether this deployment lets a row point at a loopback, private, link-local,
   * or metadata address. Both registers obey it, and so does a connectivity test,
   * so "the test worked but the save was refused" cannot happen.
   */
  get allowPrivateHosts(): boolean {
    return this.limits.allowPrivateHosts ?? true
  }

  /** Listeners notified after a durable write. */
  private readonly listeners = new Set<() => void>()

  /** Re-entrancy guard: a listener that reads the registry must not re-enter. */
  private notifying = false

  /**
   * Register a change listener, called after every durable write settles.
   * @param listener - called with no arguments once the medium accepted a write.
   * @returns a function that removes this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Announce a durable change to every listener. Called only after the medium
   * accepted the write, so a listener that reacts by re-reading observes it.
   */
  protected notify(): void {
    if (this.notifying) return
    this.notifying = true
    try {
      for (const listener of [...this.listeners]) listener()
    } finally {
      this.notifying = false
    }
  }

  /** Load one registry from the medium. */
  protected abstract loadSystem(): Promise<StoredRegistry>

  /** Load one user's registry from the medium. */
  protected abstract loadUser(userId: string): Promise<StoredRegistry>

  /**
   * Replace the system registry, refusing the write when the medium's revision
   * moved past the one the writer read.
   * @param records - the complete new list.
   * @param expectedRevision - revision the writer read, or undefined to force.
   * @returns the medium's new revision.
   */
  protected abstract writeSystem(records: readonly ExternalMcpServerRecord[], expectedRevision?: number): Promise<number>

  /** Replace one user's registry. */
  protected abstract writeUser(userId: string, records: readonly ExternalMcpServerRecord[]): Promise<void>

  /** The system registry as last loaded. */
  protected abstract snapshotSystem(): readonly ExternalMcpServerRecord[]

  /** One user's registry as last loaded, or an empty list when never read. */
  protected abstract snapshotUser(userId: string): readonly ExternalMcpServerRecord[]

  /**
   * The system registry's current revision.
   * @returns the monotonic revision the medium reports for the system register.
   */
  abstract revision(): number

  /**
   * The deployment-wide registry.
   * @returns every system row, sorted by server name.
   */
  system(): readonly ExternalMcpServerRecord[] {
    return this.snapshotSystem()
  }

  /**
   * One user's own registry.
   * @param userId - the owner whose rows are returned.
   * @returns that user's rows, sorted by server name.
   */
  user(userId: string): readonly ExternalMcpServerRecord[] {
    return this.snapshotUser(userId)
  }

  /**
   * The servers a session of this user mounts: the system registry plus that
   * user's own, disabled rows dropped.
   * @param userId - the session's user.
   * @returns the effective servers with their mount names.
   */
  effective(userId: string): EffectiveMcpServer[] {
    return effectiveServers(this.system(), this.user(userId), userId)
  }

  /**
   * Everything a caller needs to render both registries and their union.
   * @param userId - the session's user.
   * @returns system rows, the user's rows, and the effective set.
   */
  describe(userId: string): {
    system: readonly ExternalMcpServerRecord[]
    user: readonly ExternalMcpServerRecord[]
    effective: EffectiveMcpServer[]
    revision: number
  } {
    return { system: this.system(), user: this.user(userId), effective: this.effective(userId), revision: this.revision() }
  }

  /**
   * Insert or replace one row in the system registry.
   * @param raw - candidate row, validated here.
   * @param options - `expectedRevision` for optimistic concurrency.
   */
  async upsertSystem(raw: unknown, options: { expectedRevision?: number } = {}): Promise<void> {
    this.assertWritable()
    const row = this.withStamp(parseServerRecord(raw, 'mcp-servers.system', { allowPrivateHosts: this.allowPrivateHosts }))
    const current = await this.loadSystem()
    const index = current.records.findIndex(entry => serverKey(entry) === serverKey(row))
    const records = [...current.records]
    if (index === -1) {
      this.assertQuota('system', records.length, 'mcp-servers.system')
      records.push(row)
    } else {
      records[index] = row
    }
    await this.writeSystem(records, options.expectedRevision ?? current.revision)
    this.notify()
  }

  /**
   * Remove one row from the system registry. Removing an absent row is not a change.
   * @param serverName - name of the row to remove.
   * @param options - `expectedRevision` for optimistic concurrency.
   */
  async removeSystem(serverName: string, options: { expectedRevision?: number } = {}): Promise<void> {
    this.assertWritable()
    const current = await this.loadSystem()
    const records = current.records.filter(entry => serverKey(entry) !== serverName)
    if (records.length === current.records.length) return
    await this.writeSystem(records, options.expectedRevision ?? current.revision)
    this.notify()
  }

  /**
   * Insert or replace one row in a user's own registry.
   * @param userId - the owner; taken from the caller's identity, never from the body.
   * @param raw - candidate row, validated here.
   */
  async upsertUser(userId: string, raw: unknown): Promise<void> {
    this.assertWritable()
    if (userId.trim() === '') throw new TypeError('mcp-servers.user: a user row needs an owner')
    // One address policy for both registers: whoever is configuring a server is
    // the one who will use it, and a user whose intranet endpoint cannot be stored
    // is a user whose "test connection" button was a lie. An operator who needs
    // public-only endpoints sets `allowPrivateHosts: false` and both registers obey.
    const row = this.withStamp(parseServerRecord(raw, 'mcp-servers.user', { allowPrivateHosts: this.allowPrivateHosts }))
    this.assertNameBudget('user', row.serverName, userId)
    const current = await this.loadUser(userId)
    const index = current.records.findIndex(entry => serverKey(entry) === serverKey(row))
    const records = [...current.records]
    if (index === -1) {
      this.assertQuota('user', records.length, `mcp-servers.user[${userId}]`)
      records.push(row)
    } else {
      records[index] = row
    }
    await this.writeUser(userId, sortRecords(records))
    this.notify()
  }

  /**
   * Remove one row from a user's own registry.
   * @param userId - the owner.
   * @param serverName - name of the row to remove.
   */
  async removeUser(userId: string, serverName: string): Promise<void> {
    this.assertWritable()
    const current = await this.loadUser(userId)
    const records = current.records.filter(entry => serverKey(entry) !== serverName)
    if (records.length === current.records.length) return
    await this.writeUser(userId, records)
    this.notify()
  }

  /** @throws when the medium is read-only. */
  private assertWritable(): void {
    if (!this.writable) throw new Error('mcp-servers: this provider is read-only')
  }

  /**
   * @param origin - registry the row belongs to.
   * @param count - rows already in that registry.
   * @param where - diagnostic prefix naming the registry.
   * @throws when the write would exceed the configured quota.
   */
  private assertQuota(origin: McpServerOrigin, count: number, where: string): void {
    const limit = origin === 'system' ? this.limits.maxSystemServers : this.limits.maxUserServers
    if (limit === undefined) return
    if (count >= limit) {
      throw new TypeError(`${where}: at most ${String(limit)} servers can be registered`)
    }
  }

  /**
   * @param origin - registry the row belongs to.
   * @param serverName - stored name.
   * @param userId - owner, for a user row.
   * @throws when the mount name would not fit the client's namespace.
   */
  private assertNameBudget(origin: McpServerOrigin, serverName: string, userId?: string): void {
    const budget = serverNameBudget(origin, userId)
    if (serverName.length > budget) {
      throw new TypeError(
        `mcp-servers.user: serverName ${JSON.stringify(serverName)} is too long for a user row `
        + `(at most ${String(budget)} characters, so the owner prefix and name fit the 32-character tool namespace)`,
      )
    }
  }

  /**
   * @param row - validated row.
   * @returns the row with the write timestamp the medium stores.
   */
  private withStamp(row: Omit<ExternalMcpServerRecord, 'updatedAt'>): ExternalMcpServerRecord {
    return { ...row, updatedAt: this.now() }
  }

  /** @returns the timestamp assigned to a write. */
  protected now(): string {
    return new Date().toISOString()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The external MCP server registry: the system list plus one list per user. */
    mcpServers: McpServerStore
  }
}

export default McpServerStore

export * from './probe.ts'
