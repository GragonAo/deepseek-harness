/**
 * Postgres {@link TenantSchemaLifecycle}: owns each tenant's storage partition
 * as its own schema.
 * @module @deepseek-ai/dsh-tenant-admin-postgres/src/schema-lifecycle
 */

import type { TenantId } from '@deepseek-ai/dsh-tenant'
import { tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { TenantSchemaLifecycle } from '@deepseek-ai/dsh-tenant-admin'
import type { SqlExecutor } from './executor.ts'

/** PostgreSQL tenant-partition lifecycle. */
export class PostgresTenantSchemaLifecycle implements TenantSchemaLifecycle {
  constructor(private readonly executor: SqlExecutor) {}

  async provision(id: TenantId): Promise<void> {
    await this.executor.query(`CREATE SCHEMA IF NOT EXISTS ${tenantPartitionName(id)}`)
  }

  async purge(id: TenantId): Promise<void> {
    await this.executor.query(`DROP SCHEMA IF EXISTS ${tenantPartitionName(id)} CASCADE`)
  }
}
