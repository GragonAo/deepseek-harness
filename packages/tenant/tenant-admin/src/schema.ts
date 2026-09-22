/**
 * Per-tenant infrastructure lifecycle seam: pre-provision the storage
 * partition a new tenant's providers will write into, and purge it on removal.
 * A Postgres provider owns the `tenant_*` schema here; a deployment without one
 * runs the management surface without durable partition release.
 * @module @deepseek-ai/dsh-tenant-admin/src/schema
 */

import type { TenantId } from '@deepseek-ai/dsh-tenant'

/** Storage-partition lifecycle for one tenant. */
export interface TenantSchemaLifecycle {
  /**
   * Create the tenant's storage partition (for Postgres: `CREATE SCHEMA IF NOT
   * EXISTS` for its {@link tenantPartitionName}). Idempotent.
   * @param id - the tenant id whose partition is provisioned.
   */
  provision(id: TenantId): Promise<void>

  /**
   * Drop the tenant's whole storage partition, cascading every provider table
   * inside it. Only called on a deliberate hard remove.
   * @param id - the tenant id whose partition is purged.
   */
  purge(id: TenantId): Promise<void>
}
