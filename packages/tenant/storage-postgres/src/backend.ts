/**
 * (Tenant, user)-keyed PostgreSQL {@link StorageBackend}: one schema per tenant
 * (derived by {@link tenantPartitionName}) hosts `kv_meta` / `kv_record` /
 * `kv_global`; `kv_record` and `kv_global` carry an in-primary-key `user_id`
 * column so a dropped predicate cannot address another tenant's or another
 * user's tuples. Each operation resolves the ambient tenant and user at call
 * entry (before any await) and stays bound to both for the whole call.
 * @module @deepseek-ai/dsh-storage-postgres/src/backend
 */

import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { currentTenant, currentUser, requireTenant, requireUser, tenantPartitionName, userPartitionName } from '@deepseek-ai/dsh-tenant'
import type { UserId } from '@deepseek-ai/dsh-tenant'
import type { SqlExecutor } from './executor.ts'

/**
 * Schema hosting units opened outside any tenant scope. This is the
 * deployment-wide layer: the rows there belong to the host, not to a case, so
 * every tenant reads the same records. It holds the same base tables as a
 * tenant schema, and a unit's version stamp lives in it exactly as it does per
 * tenant, so an incompatible on-disk format still rejects loudly.
 */
const SYSTEM_SCHEMA = 'dsh_system'

/** JSON-encode an opaque value for a `::jsonb` column. */
function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value) as string | undefined
  if (encoded === undefined) {
    throw new Error('storage-postgres: value is not JSON-serializable')
  }
  return encoded
}

/**
 * The PostgreSQL {@link StorageBackend}. Owns the executor (connection pool)
 * and the open-unit table; `kv.open` validates names and returns a
 * {@link PostgresKvUnit} whose operations resolve the ambient tenant and user
 * per-call. Schema and base-table DDL plus the per-unit version stamp run
 * lazily, memoized per (tenant, unit), because the tenant is only known
 * inside a tenant scope.
 */
export class PostgresStorageBackend implements StorageBackend {
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }

  /** The query surface every unit operation targets. */
  readonly executor: SqlExecutor

  /** Open units by (tenant, unit) key; presence is the double-open guard. */
  private readonly units = new Map<string, PostgresKvUnit>()
  /** Deferred (tenant, unit) materializations, keyed `${schema}.${unit}`. */
  private readonly ensured = new Map<string, Promise<void>>()
  private closing: Promise<void> | undefined

  /**
   * @param executor - the query surface (a `pg` pool adapter in production).
   */
  constructor(executor: SqlExecutor) {
    this.executor = executor
  }

  /**
   * The double-open key for one unit name: scoped to the ambient
   * (tenant, user) when both are ambient (so the same declared domain opens
   * once per tenant+user), the bare name otherwise. The partition names match
   * `UNIT_NAME_RE` and neither the name nor a partition contains `.`, so the
   * composite is unambiguous.
   * @param name - the validated unit name.
   * @returns the open-unit guard key.
   */
  private unitKey(name: string, shared: boolean): string {
    const tenant = currentTenant()
    if (tenant === undefined) return `${SYSTEM_SCHEMA}.${name}`
    // Case-shared units open once per tenant; per-user units once per user.
    if (shared) return `${tenantPartitionName(tenant.id)}.${name}`
    const user = currentUser()
    if (user === undefined) return name
    return `${tenantPartitionName(tenant.id)}.${userPartitionName(user)}.${name}`
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    // Run the validation in a microtask so the guard rejects (never throws
    // synchronously) while still settling before any interleaved open() does.
    return Promise.resolve().then(() => {
      if (this.closing !== undefined) {
        throw new StorageError('closed', 'postgres storage backend is closed')
      }
      validateDescriptor(descriptor)
      const key = this.unitKey(descriptor.name, descriptor.shared === true)
      if (this.units.has(key)) {
        throw new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`)
      }
      const unit = new PostgresKvUnit(this, descriptor, key)
      this.units.set(key, unit)
      return unit
    })
  }

  /**
   * Remove one unit handle from the double-open guard.
   * @param key - the (tenant, unit) key the caller is closing.
   */
  releaseUnit(key: string): void {
    this.units.delete(key)
  }

  /**
   * Materialize one tenant's schema and stamp the unit's version exactly once.
   * Memoized so every operation on a (tenant, unit) shares one DDL/version
   * pass; a version mismatch rejects every dependent operation.
   * @param schema - the partition the unit lives in: a tenant's schema, or
   * {@link SYSTEM_SCHEMA} for a unit opened outside any tenant scope.
   * @param descriptor - the unit whose version to stamp.
   */
  ensureUnit(schema: string, descriptor: KvUnitDescriptor): Promise<void> {
    const key = `${schema}.${descriptor.name}`
    const existing = this.ensured.get(key)
    if (existing !== undefined) return existing
    const pending = this.materialize(schema, descriptor)
    this.ensured.set(key, pending)
    pending.catch(() => this.ensured.delete(key))
    return pending
  }

  private async materialize(schema: string, descriptor: KvUnitDescriptor): Promise<void> {
    await this.executor.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${schema}.kv_meta (unit text PRIMARY KEY, version integer NOT NULL)`)
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${schema}.kv_record (unit text NOT NULL, user_id text NOT NULL, table_name text NOT NULL, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (unit, user_id, table_name, key))`)
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${schema}.kv_global (unit text NOT NULL, user_id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (unit, user_id))`)
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${schema}.kv_case_record (unit text NOT NULL, table_name text NOT NULL, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (unit, table_name, key))`)
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${schema}.kv_case_global (unit text PRIMARY KEY, value jsonb NOT NULL)`)
    const rows = await this.executor.query(`SELECT version FROM ${schema}.kv_meta WHERE unit = $1`, [descriptor.name])
    const version = rows[0]?.version
    if (version === undefined) {
      await this.executor.query(`INSERT INTO ${schema}.kv_meta (unit, version) VALUES ($1, $2)`, [descriptor.name, descriptor.version])
    } else if (Number(version) !== descriptor.version) {
      throw new StorageError(
        'version-mismatch',
        `kv unit '${descriptor.name}' is stamped version ${Number(version)} in schema '${schema}', incompatible with descriptor version ${descriptor.version}`,
      )
    }
  }

  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    for (const unit of [...this.units.values()]) {
      await unit.close()
    }
    await this.executor.close()
  }
}

/** One opened unit. Operations resolve the tenant and user at call entry. */
class PostgresKvUnit implements KvUnit {
  private closed = false

  /**
   * Whether this handle was opened outside any tenant scope and therefore
   * addresses {@link SYSTEM_SCHEMA} for its whole lifetime. Captured at open
   * time: a deployment-wide unit must not change partitions when a request
   * happens to run inside a tenant scope.
   */
  private readonly systemScope: boolean

  constructor(
    private readonly backend: PostgresStorageBackend,
    private readonly descriptor: KvUnitDescriptor,
    private readonly unitKey: string,
  ) {
    // Only a shared unit can be deployment-wide: a per-user unit opened outside a
    // tenant stays tenant-bound and still fails closed when used without one.
    this.systemScope = currentTenant() === undefined && descriptor.shared === true
  }

  /**
   * Resolve the partition this operation targets, synchronously at call entry
   * and before any await, so the whole operation stays bound to one scope.
   * A handle opened outside a tenant scope addresses {@link SYSTEM_SCHEMA} for
   * its lifetime; otherwise the ambient tenant (and, for a per-user unit, the
   * ambient user) decides, and a case-shared unit needs no user because its
   * rows live under the tenant alone.
   * @returns the schema to address and the user column value when per-user.
   */
  private scope(): { schema: string; user: UserId | undefined } {
    if (this.closed) {
      throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
    }
    if (this.systemScope) {
      if (this.descriptor.shared !== true) {
        throw new StorageError('closed', `kv unit '${this.descriptor.name}' is per-user and cannot open outside a tenant scope`)
      }
      return { schema: SYSTEM_SCHEMA, user: undefined }
    }
    const tenant = requireTenant().id
    const user = this.descriptor.shared === true ? undefined : requireUser()
    return { schema: tenantPartitionName(tenant), user }
  }

  private get shared(): boolean {
    return this.descriptor.shared === true
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    const { schema, user } = this.scope()
    await this.backend.ensureUnit(schema, this.descriptor)
    const recordTable = this.shared ? 'kv_case_record' : 'kv_record'
    const recordQuery = this.shared
      ? `SELECT table_name, key, value FROM ${schema}.${recordTable} WHERE unit = $1 ORDER BY table_name, key`
      : `SELECT table_name, key, value FROM ${schema}.${recordTable} WHERE unit = $1 AND user_id = $2 ORDER BY table_name, key`
    const recordValues = this.shared ? [this.descriptor.name] : [this.descriptor.name, user]
    const rows = await this.backend.executor.query(recordQuery, recordValues)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const row of rows) {
      const table = row.table_name
      const key = row.key
      if (typeof table !== 'string' || typeof key !== 'string') continue
      ;(tables[table] ??= {})[key] = row.value
    }
    let global: unknown = null
    if (this.descriptor.hasGlobal) {
      const globalTable = this.shared ? 'kv_case_global' : 'kv_global'
      const globalQuery = this.shared
        ? `SELECT value FROM ${schema}.${globalTable} WHERE unit = $1`
        : `SELECT value FROM ${schema}.${globalTable} WHERE unit = $1 AND user_id = $2`
      const globalValues = this.shared ? [this.descriptor.name] : [this.descriptor.name, user]
      const globalRows = await this.backend.executor.query(globalQuery, globalValues)
      global = globalRows[0]?.value ?? null
    }
    return { tables, global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    const { schema, user } = this.scope()
    await this.backend.ensureUnit(schema, this.descriptor)
    if (this.shared) {
      await this.backend.executor.query(
        `INSERT INTO ${schema}.kv_case_record (unit, table_name, key, value) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (unit, table_name, key) DO UPDATE SET value = EXCLUDED.value`,
        [this.descriptor.name, table, key, encodeJson(value)],
      )
      return
    }
    await this.backend.executor.query(
      `INSERT INTO ${schema}.kv_record (unit, user_id, table_name, key, value) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (unit, user_id, table_name, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.descriptor.name, user, table, key, encodeJson(value)],
    )
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    const { schema, user } = this.scope()
    await this.backend.ensureUnit(schema, this.descriptor)
    if (this.shared) {
      await this.backend.executor.query(
        `DELETE FROM ${schema}.kv_case_record WHERE unit = $1 AND table_name = $2 AND key = $3`,
        [this.descriptor.name, table, key],
      )
      return
    }
    await this.backend.executor.query(
      `DELETE FROM ${schema}.kv_record WHERE unit = $1 AND user_id = $2 AND table_name = $3 AND key = $4`,
      [this.descriptor.name, user, table, key],
    )
  }

  async setGlobal(value: unknown): Promise<void> {
    const { schema, user } = this.scope()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`kv unit '${this.descriptor.name}' has no global slot`)
    }
    await this.backend.ensureUnit(schema, this.descriptor)
    if (this.shared) {
      await this.backend.executor.query(
        `INSERT INTO ${schema}.kv_case_global (unit, value) VALUES ($1, $2::jsonb) ON CONFLICT (unit) DO UPDATE SET value = EXCLUDED.value`,
        [this.descriptor.name, encodeJson(value)],
      )
      return
    }
    await this.backend.executor.query(
      `INSERT INTO ${schema}.kv_global (unit, user_id, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (unit, user_id) DO UPDATE SET value = EXCLUDED.value`,
      [this.descriptor.name, user, encodeJson(value)],
    )
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    // Release by the open-time key: teardown can run outside any tenant
    // scope, so the guard key must not be re-derived from the ambient tenant.
    this.backend.releaseUnit(this.unitKey)
    return Promise.resolve()
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}
