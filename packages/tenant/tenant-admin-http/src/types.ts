/**
 * Wire vocabulary of the tenant-administration surface: the tenant and member
 * views a management client reads, the payloads it sends, and the one response
 * envelope every method answers with.
 * @module @deepseek-ai/dsh-tenant-admin-http/types
 */

/**
 * Wire view of one tenant record. `enabled` and `members` normalize the
 * record's optional fields to present values, so a client never has to apply
 * the absent-means-open membership rule to a list it reads.
 */
export interface TenantAdminView {
  /** Tenant id, as the deployment registered it. */
  readonly id: string
  /** Display name recorded on the tenant. */
  readonly name: string
  /** Tenant-private root for settings, credentials, and skills on the API host. */
  readonly dataRoot: string
  /** Host directory mounted into the tenant container at `/workspace`. */
  readonly workspaceRoot: string
  /** Optional host directory of tenant tooling, mounted read-only at `/tools`. */
  readonly toolsRoot?: string
  /** Whether the tenant currently serves requests. */
  readonly enabled: boolean
  /** Egress policy of the tenant's container. */
  readonly network?: 'none' | 'internal'
  /** Admitted subjects; empty means every authenticated subject is admitted. */
  readonly members: string[]
}

/** Payload of `tenants.create`. */
export interface CreateTenantPayload {
  /** Tenant id; must be unique and a safe path segment. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Tenant-private root for settings, credentials, and skills. */
  readonly dataRoot: string
  /** Host directory mounted into the tenant container at `/workspace`. */
  readonly workspaceRoot: string
  /** Optional host directory of tenant tooling, mounted read-only at `/tools`. */
  readonly toolsRoot?: string
  /** Egress policy of the tenant's container. */
  readonly network?: 'none' | 'internal'
  /** Subjects admitted at creation. */
  readonly members?: readonly string[]
}

/** Payload of `tenants.update`; the id and `dataRoot` are immutable. */
export interface UpdateTenantPayload {
  /** New display name. */
  readonly name?: string
  /** New workspace root. */
  readonly workspaceRoot?: string
  /** New tooling root. */
  readonly toolsRoot?: string
  /** New egress policy. */
  readonly network?: 'none' | 'internal'
}

/** Payload naming one tenant. */
export interface TenantIdPayload {
  /** Tenant id. */
  readonly id: string
}

/** Payload naming one tenant and one subject. */
export interface MemberPayload extends TenantIdPayload {
  /** Authenticated subject to admit or drop. */
  readonly subject: string
}

/** Payload naming one subject, outside any tenant. */
export interface SubjectPayload {
  /** Authenticated subject whose user-tier tree is provisioned. */
  readonly subject: string
}

/** Payload of `tenants.remove`. */
export interface RemoveTenantPayload extends TenantIdPayload {
  /** Drop the storage partition and archive the host directories as well as the record. */
  readonly purge?: boolean
}

/** Business failure body: one machine code, one message, optional detail fields. */
export interface AdminErrorBody {
  /** Machine-readable failure code, stable across carriers. */
  readonly code: string
  /** Human-readable failure message. */
  readonly message: string
  /** Failure-specific detail fields, e.g. the offending id or the missing scope. */
  readonly details?: Record<string, unknown>
}

/** Response body of one management request: success carries the value, failure the error. */
export type AdminResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AdminErrorBody }
