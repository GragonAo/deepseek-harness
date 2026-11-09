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

/** Payload of `sessions.stats`: one subject's figures across every tenant. */
export interface SessionStatsPayload {
  /** Authenticated subject whose conversation figures are read. */
  readonly userId: string
}

/**
 * One tenant's conversation figures for that subject. The figures follow the
 * session-list rule, so a blank session and a delegated child are neither
 * counted nor dated.
 */
export interface SessionStatsView {
  /** Tenant the figures describe. */
  readonly tenant: string
  /** Conversations the subject has in that tenant. */
  readonly sessionCount: number
  /** Epoch ms of the subject's latest question there, or `null` when none recorded one. */
  readonly lastPromptAt: number | null
  /** Epoch ms of the newest counted conversation: its creation, or its last question when that is newer. */
  readonly updatedAt: number
}

/** Payload of `sessions.reindex`: rebuild one tenant's conversation index from its logs. */
export interface SessionReindexPayload {
  /** Tenant whose partitions are folded again. */
  readonly tenantId: string
}

/** Value of `sessions.reindex`. */
export interface SessionReindexView {
  /** Sessions the rebuild wrote or advanced. */
  readonly sessions: number
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
