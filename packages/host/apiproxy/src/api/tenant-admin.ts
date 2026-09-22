/**
 * tenant-admin domain contract: the administrative face of the tenant registry
 * (`ctx.tenantAdmin`). Every method is scope-gated on the host — a request
 * whose token lacks the administrative OIDC scope is refused with
 * `tenant-forbidden` before any record is read or written.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Wire view of one tenant record; `enabled` and `members` normalize optional fields to present values. */
export interface TenantAdminView {
  id: string
  name: string
  dataRoot: string
  workspaceRoot: string
  toolsRoot?: string
  enabled: boolean
  network?: 'none' | 'internal'
  members: string[]
}

/** Fields a `tenant.admin.create` accepts. */
export interface TenantAdminCreatePayload {
  id: string
  name: string
  dataRoot: string
  workspaceRoot: string
  toolsRoot?: string
  network?: 'none' | 'internal'
  members?: string[]
}

/** Metadata a `tenant.admin.update` may change; id and dataRoot are immutable. */
export interface TenantAdminUpdatePayload {
  name?: string
  workspaceRoot?: string
  toolsRoot?: string
  network?: 'none' | 'internal'
}

/** Tenant-admin unary methods (the map keys tenant.admin.* of RpcMethodMap). */
export interface TenantAdminApi {
  /** List every registered tenant, enabled and disabled. */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ items: TenantAdminView[] }>>

  /** Resolve one tenant, including disabled records. */
  get(request: RpcRequest<{ id: string }>): Promise<RpcResponse<TenantAdminView>>

  /** Provision a tenant: partition, host directories, registry, and durable record. */
  create(request: RpcRequest<TenantAdminCreatePayload>): Promise<RpcResponse<TenantAdminView>>

  /** Change recoverable metadata. */
  update(request: RpcRequest<{ id: string } & TenantAdminUpdatePayload>): Promise<RpcResponse<TenantAdminView>>

  /** Re-enable a disabled tenant. */
  enable(request: RpcRequest<{ id: string }>): Promise<RpcResponse<TenantAdminView>>

  /** Disable a tenant; its requests are refused until re-enabled. */
  disable(request: RpcRequest<{ id: string }>): Promise<RpcResponse<TenantAdminView>>

  /** Remove a record; `purge` also drops the partition and archives its directories. */
  remove(request: RpcRequest<{ id: string; purge?: boolean }>): Promise<RpcResponse<{ removed: true }>>

  /** List one tenant's admitted subjects. */
  membersList(request: RpcRequest<{ id: string }>): Promise<RpcResponse<{ members: string[] }>>

  /** Admit one subject, bootstrapping its `/global` tier directories. */
  membersAdd(request: RpcRequest<{ id: string; subject: string }>): Promise<RpcResponse<{ members: string[] }>>

  /** Remove one subject's admission. */
  membersRemove(request: RpcRequest<{ id: string; subject: string }>): Promise<RpcResponse<{ members: string[] }>>

  /** Pre-create one subject's `/global` tier directories. */
  usersEnsure(request: RpcRequest<{ subject: string }>): Promise<RpcResponse<{ root: string }>>
}
