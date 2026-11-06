/**
 * PostgreSQL-backed provider registry: one deployment-wide storage unit named
 * `llm_providers` keeps the administrator-managed provider routes (endpoint,
 * wire API, model list, credential) for the whole harness, not per case. The
 * unit is opened outside any tenant scope, so its rows live in the backend's
 * system schema and every tenant reads the same routes; no host-side config
 * file is involved. A write notifies the seam's listeners, which is what lets a
 * consumer re-resolve its routing in the same process instead of needing a
 * restart.
 * @module @deepseek-ai/dsh-llm-providers-postgres
 */

import { Service } from '@deepseek-ai/cordis'
import { assertProviderRecord, LlmProviderStore } from '@deepseek-ai/dsh-llm'
import type { LlmProviderRecord } from '@deepseek-ai/dsh-llm'
import { storageBackendServiceKey, type KvFacet, type KvUnit } from '@deepseek-ai/dsh-storage'

/** KV unit name hosting the provider registry; unique across the storage hub. */
const UNIT_NAME = 'llm_providers'
/** Single table whose keys are provider ids and values are provider records. */
const RECORD_TABLE = 'provider'
/**
 * Case-shared, because the unit carries no user dimension. Opening it outside a
 * tenant scope is what makes it deployment-wide; the backend requires a shared
 * unit for that, and rejects a per-user one with no tenant.
 */
const UNIT_DESCRIPTOR = { name: UNIT_NAME, version: 1, tables: [RECORD_TABLE], hasGlobal: false, shared: true } as const

/**
 * The deployment-wide provider registry. The durable store lives in the
 * storage backend's system schema, which every tenant reads, so an
 * administrator configures a provider once for the whole harness. The unit is
 * opened once at activation, outside any tenant scope, and its handle is reused
 * for every later read and write — opening it lazily inside a request would
 * bind it to that request's tenant instead.
 */
export class PostgresLlmProviderStore extends LlmProviderStore {
  // The hub (storage) resolves the postgres backend through ctx.storage.backend;
  // the backend lifecycle key (storage.backend.postgres) orders activation after
  // the backend registers, exactly as settings-postgres wires it.
  static inject = ['storage', storageBackendServiceKey('postgres')]

  /** The one open unit handle, captured at activation. */
  private unitHandle: KvUnit | undefined

  /** Last loaded records: what the synchronous snapshot answers with. */
  private cached: readonly LlmProviderRecord[] = []

  /** Re-entrancy guard: a listener may resolve profiles, which must not re-enter. */
  private notifying = false

  /** The postgres backend registered on the storage hub. */
  override get writable(): boolean {
    return true
  }

  /** The postgres backend registered on the storage hub. */
  private backendKv(): KvFacet {
    const backend = this.ctx.storage.backend.get('postgres')
    if (backend.kv === undefined) {
      throw new Error('llm-providers-postgres: postgres backend exposes no kv facet')
    }
    return backend.kv
  }

  /**
   * The open deployment-wide unit.
   * @returns the open unit handle.
   */
  private unit(): KvUnit {
    const handle = this.unitHandle
    if (handle === undefined) {
      throw new Error('llm-providers-postgres: provider unit is not open yet')
    }
    return handle
  }

  override snapshot(): readonly LlmProviderRecord[] {
    return this.cached
  }

  override async refresh(): Promise<readonly LlmProviderRecord[]> {
    const records = await this.load()
    const previous = this.cached
    this.cached = records
    if (JSON.stringify(previous) !== JSON.stringify(records)) this.notify()
    return records
  }

  override async list(): Promise<readonly LlmProviderRecord[]> {
    return await this.refresh()
  }

  /** Notify listeners unless this call is already inside a notification. */
  private notify(): void {
    if (this.notifying) return
    this.notifying = true
    try {
      this.notifyChanged()
    }
    finally {
      this.notifying = false
    }
  }

  /** Load and validate the stored records from the medium. */
  private async load(): Promise<readonly LlmProviderRecord[]> {
    const snapshot = await this.unit().loadAll()
    const table = snapshot.tables[RECORD_TABLE] ?? {}
    const records: LlmProviderRecord[] = []
    for (const [key, raw] of Object.entries(table)) {
      try {
        const record = assertProviderRecord(raw)
        if (record.id !== key) {
          throw new TypeError('stored record id "' + record.id + '" does not match its key "' + key + '"')
        }
        records.push(record)
      }
      catch (error: unknown) {
        // One unusable row must not hide the healthy ones: the registry keeps
        // serving every route that still validates, which is what keeps a bad
        // administrator write from taking the whole selector down.
        this.ctx.logger.warn('llm-providers-postgres: skipping unusable stored provider "' + key
          + '": ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    records.sort((left, right) => left.id.localeCompare(right.id))
    return records
  }

  override async upsert(record: LlmProviderRecord): Promise<void> {
    const checked = assertProviderRecord(record)
    await this.unit().putRecord(RECORD_TABLE, checked.id, checked)
    this.cached = [...this.cached.filter(entry => entry.id !== checked.id), checked]
      .sort((left, right) => left.id.localeCompare(right.id))
    this.notify()
  }

  override async remove(id: string): Promise<void> {
    const key = id.trim()
    if (key === '') throw new TypeError('llm-providers-postgres: remove needs a provider id')
    await this.unit().deleteRecord(RECORD_TABLE, key)
    this.cached = this.cached.filter(entry => entry.id !== key)
    this.notify()
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    // Opening here (plugin activation, never inside a request) is what binds the
    // unit to the deployment-wide schema instead of a request's tenant.
    this.unitHandle = await this.backendKv().open(UNIT_DESCRIPTOR)
    this.cached = await this.load()
    const handle = this.unitHandle
    yield async () => {
      this.unitHandle = undefined
      this.cached = []
      await handle.close()
    }
  }
}

export default PostgresLlmProviderStore
