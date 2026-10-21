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
 * This plugin also mounts the ambient request partition
 * (`ctx.partitionScope`) over that same authority, so a state-owning consumer
 * partitions through `@deepseek-ai/dsh-partition-scope` instead of importing
 * this package: the dependency runs provider → consumer, and a deployment that
 * mounts tenancy cannot mount it without partitioning.
 *
 * @module @deepseek-ai/dsh-tenant
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { join, posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PartitionScope, RequestPartition } from '@deepseek-ai/dsh-partition-scope'

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
 * Ambient request partition over the authority above, mounted as
 * `ctx.partitionScope` by {@link TenantRegistry}.
 *
 * Stateless: every call peeks the ambient authority, so a tree that switches
 * tenant or user observes the switch immediately and no provider state can
 * leak between requests. The partition-name derivation stays here, so a
 * consumer reads the safe identifier form without owning the rule.
 */
export class TenantPartitionScope implements PartitionScope {
  /**
   * The partition the ambient request acts as.
   * @returns the tenant and subject in scope, or `undefined` outside any tenant run.
   */
  current(): RequestPartition | undefined {
    const tenant = currentTenant()
    if (tenant === undefined) return undefined
    const user = currentUser()
    return {
      tenant: tenant.id,
      tenantName: tenantPartitionName(tenant.id),
      dataRoot: tenant.dataRoot,
      ...(user === undefined ? {} : { user, userName: userPartitionName(user) }),
    }
  }
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

/**
 * 每个 owner 层（案件、用户×案件、全局用户）里"工作目录"这一层的目录名。
 *
 * 工作目录永远是叶子，与同级的层目录（`config`/`skills`/`tools`）平级：挂载工作目录因此不会
 * 顺带交出技能与配置树。沙箱把案件那一份挂到 `/case`、用户案件那一份挂到 `/workspace`、
 * 全局用户那一份挂到 `/global`。
 */
export const TENANT_WORK_DIR_NAME = 'work'

/** 成员工作区在 `workspaceRoot` 下的目录名；沙箱把其中一个成员的那份（其下的工作目录）挂到 `/workspace`。 */
export const TENANT_USERS_DIR_NAME = 'users'

/**
 * 会话工作目录在 `workspaceRoot` 下的目录名；沙箱把其中一个成员的
 * `<workspaceRoot>/<TENANT_USERS_DIR_NAME>/<subject>/<TENANT_SESSIONS_DIR_NAME>` 挂到 `/sessions`，
 * 一次 exec 的 cwd 是它下面的一个会话目录。
 *
 * 与用户案件工作目录平级而不是同层：会话目录是正在被编辑的工作副本，同层时挂载 `/workspace`
 * 就等于顺带交出这个人所有会话的目录树。
 */
export const TENANT_SESSIONS_DIR_NAME = 'sessions'

/** 技能层在每个 owner 根下的目录名；沙箱把 `<workspaceRoot>/skills` 挂成案件技能层。 */
export const TENANT_SKILL_DIR_NAME = 'skills'

/**
 * 租户面在每个 owner 根下维护的三层目录。
 *
 * 建目录与挂载表必须认同一份名字：沙箱把 `<workspaceRoot>/skills` 挂成技能层，
 * 而那一层正是这里建出来的，两边各写一份就会有一边悄悄漏掉。
 */
export const TENANT_TIER_DIRS = ['config', TENANT_SKILL_DIR_NAME, 'tools'] as const

/**
 * 案件工作目录在沙箱内的挂载点：两个容器 provider 都把
 * `<workspaceRoot>/<TENANT_WORK_DIR_NAME>` 挂在这里，只读。
 */
export const SANDBOX_CASE_MOUNT = '/case'

/**
 * 用户案件工作区在沙箱内的挂载点：两个容器 provider 都把
 * `<workspaceRoot>/<TENANT_USERS_DIR_NAME>/<subject>/<TENANT_WORK_DIR_NAME>` 挂在这里。
 */
export const SANDBOX_WORKSPACE_MOUNT = '/workspace'

/**
 * 会话工作目录在沙箱内的挂载点：`<workspaceRoot>/<TENANT_USERS_DIR_NAME>/<subject>/<TENANT_SESSIONS_DIR_NAME>`
 * 挂在这里，一次 exec 的 cwd 是 `<SANDBOX_SESSIONS_MOUNT>/<会话 id>`。
 *
 * 它不能落在 {@link SANDBOX_WORKSPACE_MOUNT} 里面：那样用户案件工作区的挂载就把这个人所有
 * 会话的目录一起交了出去。
 */
export const SANDBOX_SESSIONS_MOUNT = '/sessions'

/**
 * 会话工作目录在沙箱内那次 exec 的环境变量：值是那个目录在沙箱内的绝对路径。
 *
 * 技能与模型按它认领自己该往哪写，因此两个 provider 必须给出同一个名字与同一个值。
 */
export const SANDBOX_WORKDIR_ENV = 'DSH_WORKDIR'

/** 受管 `DSH_*` 组里的会话 id；这个键的所有者是 `@deepseek-ai/dsh-shell-env`。 */
const DSH_SESSION_ID_ENV = 'DSH_SESSION_ID'

/**
 * 会话 id 可以作为目录名的形状。
 *
 * 会话 id 直接成为路径分量，所以这里只接受一轮保守的字符：它必须是一个普通目录名，
 * 而不是能跳出工作目录的相对路径。
 */
const SESSION_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 一次沙箱命令的会话工作目录：`<SANDBOX_SESSIONS_MOUNT>/<会话 id>`。
 *
 * 每个会话因此各有一层自己的目录，不与同一个人的其他会话抢同一层，也不混进他的案件工作区；
 * 它落在挂载进来的会话根上，容器销毁后仍然在，会话里可以继续用它。容器本地的 `workDir` 两者
 * 都做不到：那一层属于沙箱，而沙箱在同一个人的所有会话之间共享，并且会随容器一起消失。
 * @param env - 这次 exec 的环境变量；受管 `DSH_*` 组由 `dsh-shell-env` 写入。
 * @returns 沙箱内的绝对路径；这次 exec 不带会话、或会话 id 不能当目录名时为 `undefined`。
 */
export function sandboxSessionDir(env: Readonly<Record<string, string>> | undefined): string | undefined {
  const session = env?.[DSH_SESSION_ID_ENV]
  if (session === undefined || !SESSION_DIR_NAME.test(session)) return undefined
  return posix.join(SANDBOX_SESSIONS_MOUNT, session)
}

/**
 * 一个租户（及其成员）在宿主磁盘上会占用到的各个根。
 *
 * 每一项都对应执行层的一个挂载源，所以这里给出的根就是沙箱要求存在的那些路径。
 * 根缺失意味着这个部署没有配置它，而不是它的目录不用建。每个字段都接受显式的
 * `undefined`：调用方手里的正是一个可能缺席的配置值，直接传进来比在调用点写条件展开更难漏。
 */
export interface TenantLayoutInput {
  /** 租户私有根：设置、凭据与技能。 */
  readonly dataRoot?: string | undefined
  /** 沙箱挂到 `/workspace` 的那个成员工作区的上级：租户共享区与成员工作区都在它下面。 */
  readonly workspaceRoot?: string | undefined
  /** 可选：租户自己的工具根，只读挂到 `/tools`。 */
  readonly toolsRoot?: string | undefined
  /** 配置里的跨租户用户根：每个成员在它下面各有一份三层目录。 */
  readonly usersRoot?: string | undefined
  /** 可选：租户被移除时目录搬进去的归档根。 */
  readonly archiveRoot?: string | undefined
  /** 可选：部署共享的 system 技能层根；沙箱只读挂载它并派生 `/opt/data/skills/system`。 */
  readonly systemRoot?: string | undefined
  /** 可选：部署的 Python 环境根；沙箱只读挂载它本身。 */
  readonly pythonRoot?: string | undefined
  /** 要在 `workspaceRoot` 与 `usersRoot` 下各备一份目录的成员。 */
  readonly members?: readonly string[] | undefined
}

/**
 * 一个租户及其成员在宿主磁盘上需要存在的每一个目录。
 *
 * 这是建目录与出挂载表共用的唯一清单：沙箱的挂载源正是这批路径，漏掉一层就会让挂载落在
 * 一个不存在的路径上，而容器运行时会把缺失的绑定源静默建成空目录——故障因此出现在下游。
 * 父目录先于子目录，重复项只出现一次。
 * @param input - 租户记录、成员与配置里那些根。
 * @returns 需要存在的宿主目录，顺序稳定。
 */
export function tenantDirectories(input: TenantLayoutInput): string[] {
  const dirs: string[] = []
  const add = (dir: string | undefined): void => {
    if (dir !== undefined && !dirs.includes(dir)) dirs.push(dir)
  }

  add(input.dataRoot)
  add(input.archiveRoot)
  add(input.toolsRoot)
  // 部署级的两个根不属于任何租户，但沙箱从它们挂载，所以也要存在。它们各自只出沙箱
  // 实际挂载的那个路径：system 根下是技能层，Python 环境根就是挂载点本身。
  if (input.systemRoot !== undefined) {
    add(input.systemRoot)
    add(join(input.systemRoot, TENANT_SKILL_DIR_NAME))
  }
  add(input.pythonRoot)
  if (input.workspaceRoot !== undefined) {
    add(input.workspaceRoot)
    add(join(input.workspaceRoot, TENANT_WORK_DIR_NAME))
    for (const tier of TENANT_TIER_DIRS) add(join(input.workspaceRoot, tier))
  }
  for (const subject of input.members ?? []) {
    if (input.workspaceRoot !== undefined) {
      // 用户案件目录下三样东西各占一层：工作目录（可写的工作副本）、会话目录（每个会话一层），
      // 两者平级，所以挂载工作目录看不见会话目录树。
      add(join(input.workspaceRoot, TENANT_USERS_DIR_NAME, subject))
      add(join(input.workspaceRoot, TENANT_USERS_DIR_NAME, subject, TENANT_WORK_DIR_NAME))
      add(join(input.workspaceRoot, TENANT_USERS_DIR_NAME, subject, TENANT_SESSIONS_DIR_NAME))
    }
    if (input.usersRoot === undefined) continue
    add(join(input.usersRoot, subject))
    add(join(input.usersRoot, subject, TENANT_WORK_DIR_NAME))
    for (const tier of TENANT_TIER_DIRS) add(join(input.usersRoot, subject, tier))
  }
  return dirs
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
    // One plugin carries both the identity registry and the ambient partition
    // its consumers read, so mounting tenancy cannot leave partitioning
    // unregistered.
    ctx.provide('partitionScope', new TenantPartitionScope())
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
