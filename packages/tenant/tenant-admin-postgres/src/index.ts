/**
 * PostgreSQL durability provider for the tenant-administration surface: holds
 * the tenant record table (`tenant_record`) and owns each tenant's storage
 * partition as a `tenant_*` schema. Registered seams are the durable record
 * store and the schema lifecycle the `tenantAdmin` service consumes.
 * @module @deepseek-ai/dsh-tenant-admin-postgres
 */

import type { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import z from '@deepseek-ai/schemastery'
import {
  TENANT_RECORD_STORE,
  TENANT_SCHEMA_LIFECYCLE,
} from '@deepseek-ai/dsh-tenant-admin'
import { PostgresTenantRecordStore } from './record-store.ts'
import { PostgresTenantSchemaLifecycle } from './schema-lifecycle.ts'
import { createPgExecutor } from './executor.ts'
import type { SqlExecutor } from './executor.ts'

export { PostgresTenantRecordStore } from './record-store.ts'
export { PostgresTenantSchemaLifecycle } from './schema-lifecycle.ts'
export { createPgExecutor } from './executor.ts'
export type { SqlExecutor } from './executor.ts'

/** Cordis plugin name. */
export const name = 'tenant-admin-postgres'
/** The provider consumes no other services; it only contributes seams. */
export const inject = []

/** Plugin configuration. */
export interface Config {
  /**
   * PostgreSQL connection URI. The role must hold CREATE on the target
   * database: tenant provisioning issues `CREATE SCHEMA` per tenant and the
   * provider maintains the `tenant_record` table on first boot.
   */
  connectionString: string
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  connectionString: z.string().required(),
})

/** Create the shared record table once (idempotent). */
async function ensureTenantRecordTable(executor: SqlExecutor): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS tenant_record (
      id text PRIMARY KEY,
      name text NOT NULL,
      data_root text NOT NULL,
      workspace_root text NOT NULL,
      tools_root text,
      enabled boolean NOT NULL DEFAULT true,
      network text,
      members jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

/**
 * Register the durable record store and schema lifecycle for `tenantAdmin`.
 * The disposer closes the pool after both seams have left the service store.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  const executor = createPgExecutor(new Pool({ connectionString: config.connectionString }))
  ctx.provide(TENANT_RECORD_STORE, new PostgresTenantRecordStore(executor))
  ctx.provide(TENANT_SCHEMA_LIFECYCLE, new PostgresTenantSchemaLifecycle(executor))
  ctx.effect(() => {
    // Table init is self-healing on the next boot's first write if it fails
    // here; the management surface stays usable for in-memory (seed) records.
    void ensureTenantRecordTable(executor).catch((error: unknown) => {
      ctx.logger.warn('tenant-admin-postgres: tenant_record table init failed: %s', String(error))
    })
    return async () => {
      await executor.close()
    }
  }, 'tenant-admin-postgres.provideSeams')
}
