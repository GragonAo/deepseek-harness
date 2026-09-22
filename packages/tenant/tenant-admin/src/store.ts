/**
 * Durable tenant-record store seam. The `tenantAdmin` service mirrors every
 * mutation through this store so the tenant list survives restarts; a provider
 * (Postgres in production, an in-memory table in tests) owns the reads and
 * writes. The seam works in branded {@link Tenant} records: a provider
 * re-brands the plain-string `id` at its own persistence boundary.
 * @module @deepseek-ai/dsh-tenant-admin/src/store
 */

import type { Tenant, TenantId } from '@deepseek-ai/dsh-tenant'

/** Durable source of the deployment's tenant records. */
export interface TenantRecordStore {
  /**
   * Read every persisted record, in registration order.
   * @returns the records, or an empty array when none are persisted.
   */
  load(): Promise<readonly Tenant[]>

  /**
   * Persist one record, inserting or replacing by id.
   * @param tenant - the record to persist.
   */
  upsert(tenant: Tenant): Promise<void>

  /**
   * Remove one record by id.
   * @param id - the tenant id to remove.
   */
  delete(id: TenantId): Promise<void>
}
