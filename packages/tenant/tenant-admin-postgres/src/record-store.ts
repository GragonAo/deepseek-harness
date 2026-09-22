/**
 * Postgres {@link TenantRecordStore}: persists tenant records in one shared
 * `tenant_record` table so the administrator surface survives restarts.
 * @module @deepseek-ai/dsh-tenant-admin-postgres/src/record-store
 */

import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantId } from '@deepseek-ai/dsh-tenant'
import type { TenantRecordStore } from '@deepseek-ai/dsh-tenant-admin'
import type { SqlExecutor } from './executor.ts'

/** Boolean `false` means disabled; any other stored value (true/null) is the enabled default. */
const DISABLED = false

/** Map one `tenant_record` row back into a branded record. */
function rowToTenant(row: Record<string, unknown>): Tenant {
  const toolsRoot = row['tools_root'] as string | null | undefined
  const network = row['network'] as string | null | undefined
  const members = row['members']
  return {
    id: TenantId(String(row['id'])),
    name: String(row['name']),
    dataRoot: String(row['data_root']),
    workspaceRoot: String(row['workspace_root']),
    ...(toolsRoot === null || toolsRoot === undefined ? {} : { toolsRoot }),
    ...(row['enabled'] === DISABLED ? { enabled: DISABLED } : {}),
    ...(network === null || network === undefined ? {} : { network: network as 'none' | 'internal' }),
    ...(Array.isArray(members) ? { members: (members as readonly unknown[]).map(String) } : {}),
  }
}

/** PostgreSQL durable tenant-record store. */
export class PostgresTenantRecordStore implements TenantRecordStore {
  /**
   * @param executor - the shared query surface.
   * @param table - the qualified or unqualified table name (defaults to `tenant_record`).
   */
  constructor(private readonly executor: SqlExecutor, private readonly table = 'tenant_record') {}

  async load(): Promise<readonly Tenant[]> {
    const rows = await this.executor.query(
      `SELECT id, name, data_root, workspace_root, tools_root, enabled, network, members FROM ${this.table} ORDER BY id`,
    )
    return rows.map(rowToTenant)
  }

  async upsert(tenant: Tenant): Promise<void> {
    await this.executor.query(
      `INSERT INTO ${this.table} (id, name, data_root, workspace_root, tools_root, enabled, network, members, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         data_root = EXCLUDED.data_root,
         workspace_root = EXCLUDED.workspace_root,
         tools_root = EXCLUDED.tools_root,
         enabled = EXCLUDED.enabled,
         network = EXCLUDED.network,
         members = EXCLUDED.members,
         updated_at = now()`,
      [
        String(tenant.id),
        tenant.name,
        tenant.dataRoot,
        tenant.workspaceRoot,
        tenant.toolsRoot ?? null,
        tenant.enabled ?? true,
        tenant.network ?? null,
        tenant.members === undefined ? null : JSON.stringify([...tenant.members]),
      ],
    )
  }

  async delete(id: TenantId): Promise<void> {
    await this.executor.query(`DELETE FROM ${this.table} WHERE id = $1`, [String(id)])
  }
}
