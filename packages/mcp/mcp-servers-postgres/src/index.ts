/**
 * PostgreSQL-backed external MCP server registry.
 *
 * Two storage units, both case-shared (a server row belongs to the deployment,
 * not to one case) and therefore opened outside any tenant scope, so their rows
 * live in the backend's system schema and every tenant reads the same registry:
 *
 * - `mcp_system_servers` holds the administrator's list in the unit's global
 *   singleton — one document, replaced as a whole, carrying the revision that
 *   makes an administrator's concurrent edit conflict instead of silently
 *   overwriting.
 * - `mcp_user_servers` holds one record per user keyed by user id, so two users
 *   writing at the same time touch different rows and a user can only ever
 *   rewrite their own list.
 *
 * A write notifies the store's listeners after the medium accepted it, which is
 * what lets a consumer re-read the effective set in the same process instead of
 * needing a host restart.
 * @module @deepseek-ai/dsh-mcp-servers-postgres
 */

import z from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'
import {
  McpServerRevisionConflict,
  McpServerStore,
  parseStoredList,
  sortRecords,
} from '@deepseek-ai/dsh-mcp-servers'
import type { ExternalMcpServerRecord, McpServerLimits, StoredRegistry } from '@deepseek-ai/dsh-mcp-servers'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit } from '@deepseek-ai/dsh-storage'

/** Unit hosting the administrator-managed registry. */
const SYSTEM_UNIT_NAME = 'mcp_system_servers'
/** Unit hosting the per-user registries; one record per user id. */
const USER_UNIT_NAME = 'mcp_user_servers'
/** Table name inside the per-user unit. */
const USER_TABLE = 'server'

/**
 * Case-shared, no table: the system registry is one document an administrator
 * edits as a whole, so it rides the unit's global singleton.
 */
const SYSTEM_UNIT = { name: SYSTEM_UNIT_NAME, version: 1, tables: [], hasGlobal: true, shared: true } as const

/**
 * Case-shared with one record per user: sharing makes the unit addressable from
 * outside a tenant scope (so the rows land in the system schema), and the record
 * key carries the user dimension the descriptor itself does not model.
 */
const USER_UNIT = { name: USER_UNIT_NAME, version: 1, tables: [USER_TABLE], hasGlobal: false, shared: true } as const

/** Plugin configuration: quotas and host policy for writes. */
export interface Config extends McpServerLimits {}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  maxSystemServers: z.number().min(1).max(256).default(32)
    .description('Maximum number of administrator-registered servers.'),
  maxUserServers: z.number().min(1).max(64).default(8)
    .description('Maximum number of servers one user may register.'),
  allowPrivateHosts: z.boolean().default(true)
    .description(
      'Whether administrator rows may point at loopback/private/link-local hosts. '
      + 'User rows are always checked, because a user-supplied URL is untrusted.',
    ),
})

/** The document stored in a unit's global singleton / a user record. */
interface RegistryDocument {
  /** Monotonic write counter for the deployment-wide registry. */
  revision: number
  /** Rows as stored. */
  servers: unknown
}

/**
 * The deployment-wide registry, backed by two shared KV units in the storage
 * backend's system schema. Both units are opened once at activation, outside any
 * tenant scope, and those handles serve every later read and write — opening
 * lazily inside a request would bind the unit to that request's tenant instead.
 */
export default class PostgresMcpServerStore extends McpServerStore {
  // The hub (storage) resolves the postgres backend through ctx.storage.backend;
  // the backend lifecycle key orders activation after the backend registers.
  static inject = ['storage', storageBackendServiceKey('postgres')]

  /** Handle on the system unit, captured at activation. */
  private systemUnit: KvUnit | undefined

  /** Handle on the per-user unit, captured at activation. */
  private userUnit: KvUnit | undefined

  /** System registry as last read. */
  private systemRecords: readonly ExternalMcpServerRecord[] = []

  /** System revision as last read. */
  private systemRevision = 0

  /** Per-user registries as last read, keyed by user id. */
  private readonly userRecords = new Map<string, readonly ExternalMcpServerRecord[]>()

  /** @returns the system registry's current revision. */
  override revision(): number {
    return this.systemRevision
  }

  /** @returns the system registry as last read. */
  protected override snapshotSystem(): readonly ExternalMcpServerRecord[] {
    return this.systemRecords
  }

  /** @returns one user's registry as last read, empty when never read. */
  protected override snapshotUser(userId: string): readonly ExternalMcpServerRecord[] {
    return this.userRecords.get(userId) ?? []
  }

  /** The postgres backend registered on the storage hub. */
  private backendKv(): KvFacet {
    const backend = this.ctx.storage.backend.get('postgres')
    if (backend.kv === undefined) {
      throw new Error('mcp-servers-postgres: postgres backend exposes no kv facet')
    }
    return backend.kv
  }

  /** @returns the open system unit handle. */
  private systemHandle(): KvUnit {
    if (this.systemUnit === undefined) throw new Error('mcp-servers-postgres: system unit is not open')
    return this.systemUnit
  }

  /** @returns the open per-user unit handle. */
  private userHandle(): KvUnit {
    if (this.userUnit === undefined) throw new Error('mcp-servers-postgres: user unit is not open')
    return this.userUnit
  }

  /**
   * Read the system registry from the medium.
   * @returns the stored rows and revision; an absent document is an empty registry at revision 0.
   */
  protected override async loadSystem(): Promise<StoredRegistry> {
    const snapshot = await this.systemHandle().loadAll()
    const document = snapshot.global as Partial<RegistryDocument> | undefined
    const revision = typeof document?.revision === 'number' ? document.revision : 0
    const records = parseStoredList(document?.servers, 'mcp-servers-postgres.system', {
      allowPrivateHosts: this.limits.allowPrivateHosts ?? true,
    })
    this.systemRecords = records
    this.systemRevision = revision
    return { records, revision }
  }

  /**
   * Read one user's registry from the medium.
   * @param userId - the owner.
   * @returns that user's stored rows; an absent record is an empty registry.
   */
  protected override async loadUser(userId: string): Promise<StoredRegistry> {
    await this.refreshUsers()
    return { records: this.userRecords.get(userId) ?? [], revision: 0 }
  }

  /**
   * Re-read every user's registry in one query. The unit returns all records for
   * its table at once, so a refresh costs the same as reading one user and keeps
   * a snapshot read (`user()` / `effective()`) answering from current rows.
   */
  private async refreshUsers(): Promise<void> {
    const snapshot = await this.userHandle().loadAll()
    const table = snapshot.tables[USER_TABLE] ?? {}
    this.userRecords.clear()
    for (const [userId, document] of Object.entries(table)) {
      this.userRecords.set(userId, parseStoredList(
        (document as Partial<RegistryDocument> | undefined)?.servers,
        `mcp-servers-postgres.user[${userId}]`,
        // The same address policy the write obeyed: a row this deployment let a
        // user store must read back, or saving it would be a write that vanishes
        // on the next read and takes every later call down with it.
        { allowPrivateHosts: this.limits.allowPrivateHosts ?? true },
      ))
    }
  }

  /**
   * Replace the system registry, refusing a write whose expectation the medium
   * has moved past.
   * @param records - the complete new list.
   * @param expectedRevision - revision the writer read.
   * @returns the medium's new revision.
   */
  protected override async writeSystem(
    records: readonly ExternalMcpServerRecord[],
    expectedRevision?: number,
  ): Promise<number> {
    if (expectedRevision !== undefined && expectedRevision !== this.systemRevision) {
      throw new McpServerRevisionConflict(expectedRevision, this.systemRevision)
    }
    const revision = this.systemRevision + 1
    const document: RegistryDocument = { revision, servers: sortRecords(records) }
    await this.systemHandle().setGlobal(document)
    this.systemRecords = document.servers as ExternalMcpServerRecord[]
    this.systemRevision = revision
    return revision
  }

  /**
   * Replace one user's registry.
   * @param userId - the owner whose record is rewritten.
   * @param records - the complete new list for that user.
   */
  protected override async writeUser(userId: string, records: readonly ExternalMcpServerRecord[]): Promise<void> {
    const document: RegistryDocument = { revision: 1, servers: sortRecords(records) }
    await this.userHandle().putRecord(USER_TABLE, userId, document)
    this.userRecords.set(userId, document.servers as ExternalMcpServerRecord[])
  }

  /** Open both units and load the system registry before the store is usable. */
  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    // Opening here (plugin activation, never inside a request) is what binds the
    // units to the deployment-wide schema instead of a request's tenant.
    const kv = this.backendKv()
    const systemUnit = await kv.open(SYSTEM_UNIT)
    const userUnit = await kv.open(USER_UNIT)
    this.systemUnit = systemUnit
    this.userUnit = userUnit
    await this.loadSystem()
    await this.refreshUsers()
    yield async () => {
      this.systemUnit = undefined
      this.userUnit = undefined
      this.systemRecords = []
      this.systemRevision = 0
      this.userRecords.clear()
      await userUnit.close()
      await systemUnit.close()
    }
  }
}
