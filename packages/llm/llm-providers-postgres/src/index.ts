/**
 * PostgreSQL-backed provider registry for the multi-tenant carrier. One
 * case-shared storage unit named llm_providers keeps the administrator-managed
 * provider routes (endpoint, wire API, model list, credential) under the ambient
 * tenant alone — no per-user partition — so every subject of a tenant reads one
 * registry and no host-side config file is involved. A write notifies the
 * seam's listeners, which is what lets a consumer re-resolve its routing in the
 * same process instead of needing a restart.
 * @module @deepseek-ai/dsh-llm-providers-postgres
 */

import { Service } from '@deepseek-ai/cordis'
import { assertProviderRecord, LlmProviderStore } from '@deepseek-ai/dsh-llm'
import type { LlmProviderRecord } from '@deepseek-ai/dsh-llm'
import { currentTenant, requireTenant, type Tenant } from '@deepseek-ai/dsh-tenant'
import { storageBackendServiceKey, type KvFacet, type KvUnit } from '@deepseek-ai/dsh-storage'

/** KV unit name hosting the provider registry; unique across the storage hub. */
const UNIT_NAME = 'llm_providers'
/** Single table whose keys are provider ids and values are provider records. */
const RECORD_TABLE = 'provider'
/** The unit is case-shared: records live under the tenant, not per user. */
const UNIT_DESCRIPTOR = { name: UNIT_NAME, version: 1, tables: [RECORD_TABLE], hasGlobal: false, shared: true } as const

/**
 * PostgreSQL provider registry: the durable store lives in the postgres
 * backend's per-tenant schema, shared by every user of the tenant. Outside any
 * tenant scope list() serves nothing and never touches Postgres (fails safe),
 * which leaves the configuration tier as the only provider source.
 */
export class PostgresLlmProviderStore extends LlmProviderStore {
  // The hub (storage) resolves the postgres backend through ctx.storage.backend;
  // the backend lifecycle key (storage.backend.postgres) orders activation after
  // the backend registers, exactly as settings-postgres wires it.
  static inject = ['storage', storageBackendServiceKey('postgres')]

  /** Open unit handles, keyed by tenant id — a shared unit opens once per tenant. */
  private readonly units = new Map<string, KvUnit>()

  /** Last loaded records per tenant id: what the synchronous snapshot answers with. */
  private readonly cache = new Map<string, readonly LlmProviderRecord[]>()

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
   * Open (or reuse) the tenant's shared provider unit.
   * @param tenant - the ambient tenant captured at operation entry.
   * @returns the open unit handle.
   */
  private async unit(tenant: Tenant): Promise<KvUnit> {
    const key = String(tenant.id)
    const existing = this.units.get(key)
    if (existing !== undefined) return existing
    const unit = await this.backendKv().open(UNIT_DESCRIPTOR)
    this.units.set(key, unit)
    return unit
  }

  override snapshot(): readonly LlmProviderRecord[] {
    const tenant = currentTenant()
    if (tenant === undefined) return []
    return this.cache.get(String(tenant.id)) ?? []
  }

  override async refresh(): Promise<readonly LlmProviderRecord[]> {
    const records = await this.load()
    const tenant = currentTenant()
    if (tenant !== undefined) {
      const key = String(tenant.id)
      const previous = this.cache.get(key)
      this.cache.set(key, records)
      if (JSON.stringify(previous) !== JSON.stringify(records)) this.notify()
    }
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

  /** Load and validate the ambient tenant's records from the medium. */
  private async load(): Promise<readonly LlmProviderRecord[]> {
    const tenant = currentTenant()
    if (tenant === undefined) return []
    const unit = await this.unit(tenant)
    const snapshot = await unit.loadAll()
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
    const unit = await this.unit(requireTenant())
    await unit.putRecord(RECORD_TABLE, checked.id, checked)
    const cached = this.snapshot()
    const next = [...cached.filter(entry => entry.id !== checked.id), checked]
      .sort((left, right) => left.id.localeCompare(right.id))
    this.cache.set(String(requireTenant().id), next)
    this.notify()
  }

  override async remove(id: string): Promise<void> {
    const key = id.trim()
    if (key === '') throw new TypeError('llm-providers-postgres: remove needs a provider id')
    const unit = await this.unit(requireTenant())
    await unit.deleteRecord(RECORD_TABLE, key)
    const tenant = requireTenant()
    this.cache.set(String(tenant.id), this.snapshot().filter(entry => entry.id !== key))
    this.notify()
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      const handles = [...this.units.values()]
      this.units.clear()
      await Promise.allSettled(handles.map(unit => unit.close()))
    }
  }
}

export default PostgresLlmProviderStore
