/**
 * PostgreSQL-backed settings provider for the multi-tenant carrier. One KV
 * unit named `settings_doc` stores every namespace section as a record under
 * the ambient (tenant, user) — the tenant's schema plus the in-primary-key
 * `user_id` — so each subject keeps its own settings document with no
 * host-side file. Outside any tenant or user scope `load()` serves the empty
 * document (fails safe) and never touches Postgres, matching the workspace
 * registry's boot-sweep behavior.
 * @module @deepseek-ai/dsh-settings-postgres
 */

import { Service } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { currentTenant, currentUser, requireTenant, requireUser, userPartitionName, type Tenant, type UserId } from '@deepseek-ai/dsh-tenant'
import { storageBackendServiceKey, type KvFacet, type KvUnit } from '@deepseek-ai/dsh-storage'

/** KV unit name hosting the settings document; unique across the storage hub. */
const UNIT_NAME = 'settings_doc'
/** Single table whose keys are namespaces and values are raw sections. */
const SECTION_TABLE = 'section'
/** Static identity of the settings unit: one record table, no global slot. */
const UNIT_DESCRIPTOR = { name: UNIT_NAME, version: 1, tables: [SECTION_TABLE], hasGlobal: false } as const

/**
 * PostgreSQL `SettingsProvider`: the raw document lives in the `postgres`
 * storage backend's per-tenant schema. Reads and writes resolve the ambient
 * tenant at call entry; outside a tenant scope the document is empty.
 */
export class PostgresSettingsProvider extends SettingsProvider {
  // The hub (`storage`) resolves the postgres backend through `ctx.storage.backend`;
  // the backend lifecycle key (`storage.backend.postgres`) orders activation
  // after the backend registers, exactly as `storage-domain` wires it.
  static inject = ['storage', storageBackendServiceKey('postgres')]

  /** Open unit handles, keyed by (tenant, user) — the ambient scope at first use. */
  private readonly units = new Map<string, KvUnit>()

  override get writable(): boolean {
    return true
  }

  /** One document per ambient tenant. */
  protected override get tenantScoped(): boolean {
    return true
  }

  /** One document per ambient user within the tenant. */
  protected override get userScoped(): boolean {
    return true
  }

  /** The postgres backend registered on the storage hub. */
  private backendKv(): KvFacet {
    const backend = this.ctx.storage.backend.get('postgres')
    if (backend.kv === undefined) {
      throw new Error('settings-postgres: postgres backend exposes no kv facet')
    }
    return backend.kv
  }

  /** Open (or reuse) the per-(tenant, user) settings unit, under the ambient scope. */
  private async unit(tenant: Tenant, user: UserId): Promise<KvUnit> {
    const key = `${tenant.id}.${userPartitionName(user)}`
    const existing = this.units.get(key)
    if (existing !== undefined) return existing
    const unit = await this.backendKv().open(UNIT_DESCRIPTOR)
    this.units.set(key, unit)
    return unit
  }

  protected async load(): Promise<Record<string, unknown>> {
    const tenant = currentTenant()
    const user = currentUser()
    if (tenant === undefined || user === undefined) return {}
    const unit = await this.unit(tenant, user)
    const snapshot = await unit.loadAll()
    return snapshot.tables[SECTION_TABLE] ?? {}
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    const unit = await this.unit(requireTenant(), requireUser())
    await unit.putRecord(SECTION_TABLE, ns, section)
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // Yield the unit teardown BEFORE the base init so disposal runs it AFTER
    // the base drains queued writes: an in-flight persist must never observe a
    // closed unit.
    yield async () => {
      const handles = [...this.units.values()]
      this.units.clear()
      await Promise.allSettled(handles.map(unit => unit.close()))
    }
    yield* super[Service.init]()
  }
}

export default PostgresSettingsProvider
