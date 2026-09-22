/**
 * Tenant identity, request-scoped authority, and registry for multi-tenant
 * DeepSeek Harness deployments.
 *
 * `TenantId` is an opaque branded id owned here; a `Tenant` is the resolved
 * record an authenticated request acts as, and its optional `members` lists the
 * authenticated subjects admitted to it. The request-scoped authority is an
 * `AsyncLocalStorage` (the `withInitiator` pattern): `runWithTenant(tenant, fn)`
 * enters a tenant for one synchronous/asynchronous execution tree,
 * `currentTenant()` peeks, and `requireTenant()` fails closed outside any run.
 * `runWithUser(user, fn)` / `currentUser()` / `requireUser()` carry the
 * authenticated subject the same way, because per-user isolation resolves the
 * subject alongside the tenant. `TenantRegistry` (`ctx.tenants`) holds the
 * deployment's tenant records and resolves an authenticated id to a live
 * `Tenant`, rejecting absent, disabled, or non-member subjects fail-closed.
 *
 * Isolation is layered here, not in core: multi-tenant providers call
 * `requireTenant()` for every open operation and enforce the durable
 * `tenant_id`/schema binding they own, so a request can only address the tenant
 * its authentication minted.
 *
 * @module @deepseek-ai/dsh-tenant
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque cross-boundary tenant id. */
export type TenantId = Branded<'TenantId'>

/**
 * Brand a validated tenant id string (a plain cast — zero runtime cost).
 * @param id - the validated tenant id string.
 * @returns the branded tenant id.
 */
export function TenantId(id: string): TenantId {
  return id as TenantId
}

/** Opaque cross-boundary user id (an authenticated subject, such as an OIDC `sub`). */
export type UserId = Branded<'UserId'>

/**
 * Brand a validated subject string as a {@link UserId} (a plain cast — zero
 * runtime cost).
 * @param id - the validated subject string.
 * @returns the branded user id.
 */
export function UserId(id: string): UserId {
  return id as UserId
}

/** Longest PostgreSQL identifier this partition name stays under. */
const MAX_PARTITION_LENGTH = 63

/**
 * Default OIDC scope that admits the tenant-administration surface. The
 * carrier and the `tenantAdmin` service share this default so a deployment
 * that does not override it gets a consistent administrative boundary; one
 * that does override it must set the same value on both.
 */
export const DEFAULT_TENANT_ADMIN_SCOPE = 'dsh:tenant-admin'

/**
 * Derive the tenant's deterministic, storage-partition name. The multi-tenant
 * Postgres backends use this as a per-tenant schema name so a dropped
 * `tenant_id` predicate still cannot address another tenant's tuples. The name
 * is a pure function of the id: a sanitized prefix plus a collision-resistant
 * hash suffix, always a safe Postgres identifier.
 * @param tenantId - the tenant id.
 * @returns the tenant's storage-partition (schema) name.
 */
export function tenantPartitionName(tenantId: TenantId): string {
  const sanitized = tenantId.toLowerCase().replace(/[^a-z0-9_]/gu, '_')
  const prefix = sanitized.slice(0, 40) || 'x'
  const suffix = createHash('sha256').update(tenantId).digest('hex').slice(0, 12)
  const name = `tenant_${prefix}_${suffix}`
  return name.length <= MAX_PARTITION_LENGTH ? name : name.slice(0, MAX_PARTITION_LENGTH)
}

/**
 * Derive the user's deterministic storage-partition name. The raw
 * {@link UserId} is the durable `user_id` column value; this name is the safe
 * identifier form for in-memory guard keys and container names that must be a
 * Postgres/docker-safe token. Mirrors {@link tenantPartitionName} with a
 * `user_` prefix.
 * @param user - the authenticated subject.
 * @returns the user's partition name.
 */
export function userPartitionName(user: UserId): string {
  const sanitized = user.toLowerCase().replace(/[^a-z0-9_]/gu, '_')
  const prefix = sanitized.slice(0, 40) || 'x'
  const suffix = createHash('sha256').update(user).digest('hex').slice(0, 12)
  const name = `user_${prefix}_${suffix}`
  return name.length <= MAX_PARTITION_LENGTH ? name : name.slice(0, MAX_PARTITION_LENGTH)
}

/**
 * The resolved record an authenticated request acts as. `workspaceRoot` is the
 * host directory bind-mounted into the tenant container at `/workspace`;
 * `toolsRoot` is optionally bind-mounted read-only at `/tools`.
 */
export interface Tenant {
  readonly id: TenantId
  readonly name: string
  /** Tenant-private root for settings, credentials, and skills on the API host. */
  readonly dataRoot: string
  /** Host directory bind-mounted into the tenant container at `/workspace`. */
  readonly workspaceRoot: string
  /** Optional host directory of tenant tooling, bind-mounted read-only at `/tools`. */
  readonly toolsRoot?: string
  /** A disabled tenant must serve no request. */
  readonly enabled?: boolean
  /** Egress policy for the tenant's container. */
  readonly network?: 'none' | 'internal'
  /** Authenticated subjects admitted to this tenant; absent or empty means open to any subject. */
  readonly members?: readonly string[]
}

/**
 * One tenant record a cordis.yml supplies: the wire shape of {@link Tenant}
 * with a plain-string `id` that config registration brands on the way in.
 */
export interface TenantInput {
  /** Tenant id, brand-cast to {@link TenantId} when the record is registered. */
  id: string
  /** Display name recorded on the tenant. */
  name: string
  /** Tenant-private root for settings, credentials, and skills on the API host. */
  dataRoot: string
  /** Host directory bind-mounted into the tenant container at `/workspace`. */
  workspaceRoot: string
  /** Optional host directory of tenant tooling, bind-mounted read-only at `/tools`. */
  toolsRoot?: string
  /** A disabled tenant must serve no request. */
  enabled?: boolean
  /** Egress policy for the tenant's container. */
  network?: 'none' | 'internal'
  /** Authenticated subjects admitted to this tenant; absent or empty means open to any subject. */
  members?: string[]
}

/** Plugin configuration. */
export interface Config {
  /** Tenant records registered at boot; `register` brand-casts each id. */
  tenants?: TenantInput[]
}

/** Tenant-scoped failure codes. */
export type TenantErrorCode =
  | 'NO_TENANT_IN_SCOPE'
  | 'NO_USER_IN_SCOPE'
  | 'DUPLICATE_TENANT'
  | 'TENANT_UNKNOWN'
  | 'TENANT_DISABLED'
  | 'NOT_A_MEMBER'
  | 'MISSING_SCOPE'

/**
 * Structured error for tenant resolution and scoping failures.
 */
export class TenantError extends Error {
  /** Machine-readable failure code. */
  readonly code: TenantErrorCode

  constructor(code: TenantErrorCode, message: string) {
    super(message)
    this.name = 'TenantError'
    this.code = code
  }
}

/** The one module-scoped authority store every tenant-aware provider reads. */
const tenantStorage = new AsyncLocalStorage<Tenant>()

/**
 * Enter a tenant for one synchronous or asynchronous execution tree. Nested
 * runs shadow the outer tenant and restore it on unwind.
 * @param tenant - the resolved tenant to act as.
 * @param fn - work whose synchronous and asynchronous children read this tenant.
 * @returns `fn`'s result (possibly a promise).
 */
export function runWithTenant<T>(tenant: Tenant, fn: () => T): T {
  return tenantStorage.run(tenant, fn)
}

/**
 * The ambient tenant, or `undefined` outside an authenticated request.
 * @returns the current tenant.
 */
export function currentTenant(): Tenant | undefined {
  return tenantStorage.getStore()
}

/**
 * The ambient tenant, failing closed when no request-scoped tenant exists.
 * @returns the current tenant.
 * @throws `TenantError` with code `NO_TENANT_IN_SCOPE` outside any run.
 */
export function requireTenant(): Tenant {
  const tenant = tenantStorage.getStore()
  if (tenant === undefined) {
    throw new TenantError(
      'NO_TENANT_IN_SCOPE',
      'no tenant is in scope for this operation; it must run inside an authenticated request',
    )
  }
  return tenant
}

/**
 * The one module-scoped authority store carrying the authenticated subject.
 * Layered inside `runWithTenant` by the carrier: providers that partition per
 * user read `requireUser()` alongside `requireTenant()`.
 */
const userStorage = new AsyncLocalStorage<UserId>()

/**
 * Enter a user for one synchronous or asynchronous execution tree. Nested
 * runs shadow the outer user and restore it on unwind.
 * @param user - the authenticated subject to act as.
 * @param fn - work whose synchronous and asynchronous children read this user.
 * @returns `fn`'s result (possibly a promise).
 */
export function runWithUser<T>(user: UserId, fn: () => T): T {
  return userStorage.run(user, fn)
}

/**
 * The ambient user, or `undefined` outside an authenticated request.
 * @returns the current subject.
 */
export function currentUser(): UserId | undefined {
  return userStorage.getStore()
}

/**
 * The ambient user, failing closed when no request-scoped subject exists.
 * @returns the current subject.
 * @throws `TenantError` with code `NO_USER_IN_SCOPE` outside any run.
 */
export function requireUser(): UserId {
  const user = userStorage.getStore()
  if (user === undefined) {
    throw new TenantError(
      'NO_USER_IN_SCOPE',
      'no user is in scope for this operation; it must run inside an authenticated request',
    )
  }
  return user
}

/**
 * The one module-scoped authority store carrying the authenticated token's
 * OIDC scopes. Layered inside `runWithTenant`/`runWithUser` by the carrier;
 * the management surface reads `requireScope()` to admit administrative
 * requests that cross tenant boundaries.
 */
const scopesStorage = new AsyncLocalStorage<readonly string[] | undefined>()

/**
 * Enter the authenticated token's OIDC scopes for one execution tree. Nested
 * runs shadow the outer scopes and restore them on unwind.
 * @param scopes - the token scopes, or `undefined` when the credential carried none.
 * @param fn - work whose synchronous and asynchronous children read these scopes.
 * @returns `fn`'s result (possibly a promise).
 */
export function runWithScopes<T>(scopes: readonly string[] | undefined, fn: () => T): T {
  return scopesStorage.run(scopes, fn)
}

/**
 * The ambient token scopes, or `undefined` when none are in scope.
 * @returns the current scopes.
 */
export function currentScopes(): readonly string[] | undefined {
  return scopesStorage.getStore()
}

/**
 * Fail closed when the ambient token lacks one required scope. Administrative
 * surfaces call this before any cross-tenant operation.
 * @param scope - the scope the ambient token must carry.
 * @returns the ambient scopes when the scope is present.
 * @throws `TenantError` with code `MISSING_SCOPE` when absent.
 */
export function requireScope(scope: string): readonly string[] {
  const scopes = scopesStorage.getStore()
  if (!scopes?.includes(scope)) {
    throw new TenantError('MISSING_SCOPE', `this operation requires scope '${scope}'`)
  }
  return scopes
}

/**
 * Whether a subject may act in the tenant. A tenant without a `members` list
 * (absent or empty) is open to any authenticated subject; one with a list
 * admits only the listed subjects.
 * @param tenant - the resolved tenant.
 * @param subject - the authenticated subject.
 * @returns true when the subject is a member.
 */
export function isTenantMember(tenant: Tenant, subject: UserId): boolean {
  const members = tenant.members
  return members === undefined || members.length === 0 || members.includes(subject)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenants: TenantRegistry
  }
}

/**
 * Tenant record registry (`ctx.tenants`). Records are registered by the
 * deployment assembly — from cordis.yml through {@link Config.tenants}, or by
 * calling {@link register} directly — and authentication resolves an
 * authenticated id through {@link resolve}, which rejects absent or disabled
 * tenants fail-closed.
 */
export class TenantRegistry extends Service {
  static Config: z<Config> = z.object({
    tenants: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      dataRoot: z.string().min(1),
      workspaceRoot: z.string().min(1),
      toolsRoot: z.string(),
      enabled: z.boolean(),
      network: z.union(['none', 'internal'] as const),
      members: z.array(z.string()),
    })).default([]),
  })

  private readonly records = new Map<TenantId, Tenant>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tenants')
    for (const input of config.tenants ?? []) {
      const record: Tenant = {
        id: TenantId(input.id),
        name: input.name,
        dataRoot: input.dataRoot,
        workspaceRoot: input.workspaceRoot,
        ...(input.toolsRoot !== undefined ? { toolsRoot: input.toolsRoot } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.network !== undefined ? { network: input.network } : {}),
        ...(input.members !== undefined ? { members: input.members } : {}),
      }
      ctx.effect(() => this.register(record), `tenants: register ${String(record.id)}`)
    }
  }

  /**
   * Register one tenant record. Returns the exact disposer that removes it.
   * @param tenant - the tenant record.
   * @returns the disposer.
   * @throws `TenantError` code `DUPLICATE_TENANT` when the id exists.
   */
  register(tenant: Tenant): () => void {
    if (this.records.has(tenant.id)) {
      throw new TenantError('DUPLICATE_TENANT', `tenant '${tenant.id}' is already registered`)
    }
    this.records.set(tenant.id, tenant)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.delete(tenant.id)
    }
  }

  /**
   * Replace one registered record's metadata in place. The id is immutable: a
   * patch names the record it updates but cannot re-brand it. Returns the
   * exact disposer that restores the previous record.
   * @param tenant - the replacement record, with the same id as the current one.
   * @returns the disposer restoring the previous record.
   * @throws `TenantError` code `TENANT_UNKNOWN` when the id is unregistered.
   */
  update(tenant: Tenant): () => void {
    const previous = this.records.get(tenant.id)
    if (previous === undefined) {
      throw new TenantError('TENANT_UNKNOWN', `tenant '${tenant.id}' is not registered`)
    }
    this.records.set(tenant.id, tenant)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.set(tenant.id, previous)
    }
  }

  /**
   * Remove one registered record. Returns the exact disposer that re-registers
   * the removed record.
   * @param id - the tenant id to remove.
   * @returns the disposer re-registering the removed record.
   * @throws `TenantError` code `TENANT_UNKNOWN` when the id is unregistered.
   */
  remove(id: TenantId): () => void {
    const previous = this.records.get(id)
    if (previous === undefined) {
      throw new TenantError('TENANT_UNKNOWN', `tenant '${id}' is not registered`)
    }
    this.records.delete(id)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.records.set(id, previous)
    }
  }

  /**
   * Look up a registered record without failing on its absence.
   * @param id - the tenant id.
   * @returns the record, or undefined when unknown.
   */
  get(id: TenantId): Tenant | undefined {
    return this.records.get(id)
  }

  /**
   * Resolve an authenticated id to a live tenant, failing closed.
   * @param id - the authenticated tenant id.
   * @returns the record.
   * @throws `TenantError` code `TENANT_UNKNOWN` when unregistered, or
   *   `TENANT_DISABLED` when the record is disabled.
   */
  resolve(id: TenantId): Tenant {
    const tenant = this.records.get(id)
    if (tenant === undefined) {
      throw new TenantError('TENANT_UNKNOWN', `tenant '${id}' is not registered`)
    }
    if (tenant.enabled === false) {
      throw new TenantError('TENANT_DISABLED', `tenant '${id}' is disabled`)
    }
    return tenant
  }

  /**
   * Resolve an authenticated id to a live tenant, then fail closed when the
   * subject is not a member of it. The membership gate is here, on top of
   * {@link resolve}, so the carrier authenticates and authorizes in one call.
   * @param id - the authenticated tenant id.
   * @param subject - the authenticated subject.
   * @returns the record.
   * @throws `TenantError` code `TENANT_UNKNOWN`/`TENANT_DISABLED`, or
   *   `NOT_A_MEMBER` when the tenant lists members excluding this subject.
   */
  resolveMember(id: TenantId, subject: UserId): Tenant {
    const tenant = this.resolve(id)
    if (!isTenantMember(tenant, subject)) {
      throw new TenantError('NOT_A_MEMBER', `subject '${subject}' is not a member of tenant '${id}'`)
    }
    return tenant
  }

  /**
   * All registered records in registration order.
   * @returns a fresh array.
   */
  list(): Tenant[] {
    return [...this.records.values()]
  }
}

export default TenantRegistry
