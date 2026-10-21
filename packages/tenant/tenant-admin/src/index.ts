/**
 * Tenant-administration service (`ctx.tenantAdmin`): the management surface
 * that provisions, updates, and removes tenant records and their members,
 * behind an OIDC-scope gate. It owns nothing durable itself — it mirrors every
 * mutation into the injected {@link TenantRegistry} for live resolution and,
 * when a provider is present, into a {@link TenantRecordStore} and a
 * {@link TenantSchemaLifecycle} so records and storage partitions survive
 * restarts. The `agentHttp` carrier carries the token scopes into request
 * scope, and administrative cross-tenant work still authenticates as a
 * subject of some (any) enabled tenant; the scope gate here is what admits it.
 *
 * @module @deepseek-ai/dsh-tenant-admin
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_TENANT_ADMIN_SCOPE,
  TenantError,
  TenantId,
  requireScope,
} from '@deepseek-ai/dsh-tenant'
import { tenantDirectories, type Tenant } from '@deepseek-ai/dsh-tenant'
import type { TenantRecordStore } from './store.ts'
import type { TenantSchemaLifecycle } from './schema.ts'

export type { TenantRecordStore } from './store.ts'
export type { TenantSchemaLifecycle } from './schema.ts'

/** Service key a durable record store registers under. */
export const TENANT_RECORD_STORE = 'tenantRecordStore'
/** Service key a storage-partition lifecycle registers under. */
export const TENANT_SCHEMA_LIFECYCLE = 'tenantSchemaLifecycle'

/** Administrative failure codes owned by this surface. */
export type TenantAdminErrorCode = 'invalid-input' | 'provision-failed'

/**
 * Structured error for administrative failures that are not tenant-resolution
 * errors (which reuse {@link TenantError}).
 */
export class TenantAdminError extends Error {
  /** Machine-readable failure code. */
  readonly code: TenantAdminErrorCode

  constructor(code: TenantAdminErrorCode, message: string) {
    super(message)
    this.name = 'TenantAdminError'
    this.code = code
  }
}

/** Fields a `create` accepts (dataRoot/workspaceRoot are required, as in cordis.yml). */
export interface CreateTenantRequest {
  readonly id: string
  readonly name: string
  readonly dataRoot: string
  readonly workspaceRoot: string
  readonly toolsRoot?: string
  readonly network?: 'none' | 'internal'
  readonly members?: readonly string[]
}

/** Metadata `update` may change; the id and dataRoot are immutable. */
export interface UpdateTenantRequest {
  readonly name?: string
  readonly workspaceRoot?: string
  readonly toolsRoot?: string
  readonly network?: 'none' | 'internal'
}

/** Plugin configuration. */
export interface Config {
  /** OIDC scope that admits the management surface. */
  adminScope?: string
  /** Root holding one `<subject>/{config,skills,tools}` tree per member. */
  usersRoot?: string
  /** Purge archives dataRoot/workspaceRoot under this root instead of deleting them. */
  archiveRoot?: string
  /** Deployment-wide root holding the sandbox's shared system skill tree; mounted read-only. */
  systemRoot?: string
  /** Deployment-wide root of the Python environment the sandbox runs; mounted read-only. */
  pythonRoot?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenantAdmin: TenantAdmin
    tenantRecordStore: TenantRecordStore
    tenantSchemaLifecycle: TenantSchemaLifecycle
  }
}

const SAFE_SEGMENT_RE = /[/\\\x00]/u

/** Reject ids/subjects that would escape their host directory as path segments. */
function assertSafeSegment(value: string, what: string): void {
  if (value === '' || value === '.' || value === '..' || SAFE_SEGMENT_RE.test(value)) {
    throw new TenantAdminError('invalid-input', `${what} '${value}' is not a safe path segment`)
  }
}

/**
 * Tenant administration service. Load with a tenant registry always present;
 * persistence and partition lifecycle are optional providers read by key so a
 * test assembly can run the surface ephemeral.
 */
export class TenantAdmin extends Service {
  static inject = ['tenants']
  static Config: z<Config> = z.object({
    adminScope: z.string().default(DEFAULT_TENANT_ADMIN_SCOPE),
    usersRoot: z.string(),
    archiveRoot: z.string(),
    systemRoot: z.string(),
    pythonRoot: z.string(),
  })

  private readonly registry = this.ctx.tenants
  private readonly adminScope: string
  private readonly usersRoot: string | undefined
  private readonly archiveRoot: string | undefined
  private readonly systemRoot: string | undefined
  private readonly pythonRoot: string | undefined

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'tenantAdmin')
    this.adminScope = config.adminScope ?? DEFAULT_TENANT_ADMIN_SCOPE
    this.usersRoot = config.usersRoot
    this.archiveRoot = config.archiveRoot
    this.systemRoot = config.systemRoot
    this.pythonRoot = config.pythonRoot
    // A durable store is authoritative over the config seed: persisted records
    // overwrite same-id seeds, and records absent from config are re-added.
    // The store is an optional provider, and composition does not order rows, so
    // hydration waits on the service key: it runs when a store mounts, and again
    // if a late provider replaces it.
    ctx.inject([TENANT_RECORD_STORE], (storeCtx) => {
      storeCtx.effect(() => {
        void this.hydrate().catch((error: unknown) => {
          storeCtx.logger.warn('tenantAdmin: record-store hydration failed: %s', String(error))
        })
        return () => {}
      }, 'tenantAdmin: hydrate from record store')
    })
  }

  /**
   * Load persisted records into the live registry (store wins over config seeds), then
   * create the directories the sandbox mounts: the deployment-wide roots and every
   * registered tenant's tree. Runs again when a late provider replaces the store, so
   * directory creation is idempotent and the deployment needs no pre-created subdirectory.
   */
  private async hydrate(): Promise<void> {
    const records = await this.store?.load()
    for (const record of records ?? []) {
      if (this.registry.get(record.id) === undefined) this.registry.register(record)
      else this.registry.update(record)
    }
    await this.mkdirAll(tenantDirectories({ systemRoot: this.systemRoot, pythonRoot: this.pythonRoot }))
    for (const record of this.registry.list()) await this.bootstrapTenantDirs(record)
  }

  /** Fail closed unless the ambient token carries the administrative scope. */
  private requireAdmin(): void {
    requireScope(this.adminScope)
  }

  /**
   * Read one record without the enabled gate: administration must see and act
   * on disabled tenants (re-enable, update, remove), unlike the carrier's
   * request path which resolves through the enabled gate.
   * @param id - the tenant id.
   * @returns the record.
   * @throws `TenantError` code `TENANT_UNKNOWN` when unregistered.
   */
  private requireRecord(id: string): Tenant {
    const record = this.registry.get(TenantId(id))
    if (record === undefined) {
      throw new TenantError('TENANT_UNKNOWN', `tenant '${id}' is not registered`)
    }
    return record
  }

  /** The durable store, when a provider registered one. */
  private get store(): TenantRecordStore | undefined {
    return this.ctx.get(TENANT_RECORD_STORE)
  }

  /** The partition lifecycle, when a provider registered one. */
  private get lifecycle(): TenantSchemaLifecycle | undefined {
    return this.ctx.get(TENANT_SCHEMA_LIFECYCLE)
  }

  /**
   * List every registered tenant, in registration order.
   * @returns the records, enabled and disabled.
   */
  list(): Tenant[] {
    this.requireAdmin()
    return this.registry.list()
  }

  /**
   * Resolve one tenant, including disabled records.
   * @param id - the tenant id.
   * @returns the record.
   */
  get(id: string): Tenant {
    this.requireAdmin()
    return this.requireRecord(id)
  }

  /**
   * Provision a tenant: create its storage partition and host directories,
   * register it, and persist the record.
   * @param request - the create fields.
   * @returns the created record.
   */
  async create(request: CreateTenantRequest): Promise<Tenant> {
    this.requireAdmin()
    const id = TenantId(this.normalizeCreate(request))
    if (this.registry.get(id) !== undefined) {
      throw new TenantError('DUPLICATE_TENANT', `tenant '${id}' is already registered`)
    }
    const record: Tenant = {
      id,
      name: request.name,
      dataRoot: request.dataRoot,
      workspaceRoot: request.workspaceRoot,
      ...(request.toolsRoot !== undefined ? { toolsRoot: request.toolsRoot } : {}),
      ...(request.network !== undefined ? { network: request.network } : {}),
      ...(request.members !== undefined ? { members: [...request.members] } : {}),
    }
    await this.provision(record)
    this.registry.register(record)
    try {
      await this.store?.upsert(record)
    } catch (error: unknown) {
      this.registry.remove(id)
      throw this.provisionFailure('persist', error)
    }
    return record
  }

  /**
   * Change recoverable metadata; `id` and `dataRoot` are immutable.
   * @param id - the tenant id.
   * @param patch - the fields to change (absent fields are left unchanged).
   * @returns the updated record.
   */
  async update(id: string, patch: UpdateTenantRequest): Promise<Tenant> {
    this.requireAdmin()
    const current = this.requireRecord(id)
    const next: Tenant = {
      ...current,
      name: patch.name ?? current.name,
      workspaceRoot: patch.workspaceRoot ?? current.workspaceRoot,
      ...(patch.toolsRoot !== undefined ? { toolsRoot: patch.toolsRoot } : {}),
      ...(patch.network !== undefined ? { network: patch.network } : {}),
    }
    this.registry.update(next)
    try {
      await this.store?.upsert(next)
    } catch (error: unknown) {
      this.registry.update(current)
      throw this.provisionFailure('persist', error)
    }
    return next
  }

  /**
   * Re-enable a disabled tenant.
   * @param id - the tenant id.
   * @returns the re-enabled record.
   */
  async enable(id: string): Promise<Tenant> {
    this.requireAdmin()
    return this.setEnabled(id, true)
  }

  /**
   * Disable a tenant; its requests are refused by `resolve` until re-enabled.
   * @param id - the tenant id.
   * @returns the disabled record.
   */
  async disable(id: string): Promise<Tenant> {
    this.requireAdmin()
    return this.setEnabled(id, false)
  }

  /**
   * Remove a tenant record; `purge` also drops the partition and archives the
   * host directories instead of deleting them.
   * @param id - the tenant id.
   * @param purge - when true, drop the partition and archive the directories.
   * @returns a fixed acknowledgement.
   */
  async remove(id: string, purge: boolean): Promise<{ removed: true }> {
    this.requireAdmin()
    const record = this.requireRecord(id)
    if (purge) {
      await this.lifecycle?.purge(record.id)
      await this.archiveDirs(record)
    }
    this.registry.remove(record.id)
    try {
      await this.store?.delete(record.id)
    } catch (error: unknown) {
      this.registry.register(record)
      throw this.provisionFailure('persist', error)
    }
    return { removed: true }
  }

  /**
   * List one tenant's admitted subjects.
   * @param id - the tenant id.
   * @returns the admitted subjects (never mutated by callers).
   */
  membersList(id: string): string[] {
    this.requireAdmin()
    return [...(this.requireRecord(id).members ?? [])]
  }

  /**
   * Admit one subject, bootstrapping the host directories its sandbox mounts: the
   * tenant's `<workspaceRoot>/users/<subject>` and the subject's `/global` tier.
   * @param id - the tenant id.
   * @param subject - the JWT `sub` to admit.
   * @returns the tenant's members after the change.
   */
  async membersAdd(id: string, subject: string): Promise<string[]> {
    this.requireAdmin()
    assertSafeSegment(subject, 'subject')
    // The record resolves before any directory is created: an unknown tenant must
    // not leave a subject's host directories behind for a membership that failed.
    const record = this.requireRecord(id)
    await this.bootstrapUserDirs(subject, record.workspaceRoot)
    return this.withMembers(id, members => members.includes(subject) ? members : [...members, subject])
  }

  /**
   * Remove one subject's admission (its data and directories are untouched).
   * @param id - the tenant id.
   * @param subject - the JWT `sub` to remove.
   * @returns the tenant's members after the change.
   */
  async membersRemove(id: string, subject: string): Promise<string[]> {
    this.requireAdmin()
    return this.withMembers(id, members => members.filter(member => member !== subject))
  }

  /**
   * Pre-create one subject's `/global` tier directories. The per-tenant case
   * workspace is not included: this operation names no tenant, so it has no
   * `workspaceRoot` to create one under, and `create`/`membersAdd` own that path.
   * @param subject - the JWT `sub` to prepare.
   * @returns the host directory that now holds the subject's tiers.
   */
  async usersEnsure(subject: string): Promise<{ root: string }> {
    this.requireAdmin()
    assertSafeSegment(subject, 'subject')
    if (this.usersRoot === undefined) {
      throw new TenantAdminError('invalid-input', 'usersRoot is not configured; cannot bootstrap user directories')
    }
    await this.bootstrapUserDirs(subject)
    return { root: join(this.usersRoot, subject) }
  }

  /** Flip one tenant's enabled flag, mirroring registry + store. */
  private async setEnabled(id: string, enabled: boolean): Promise<Tenant> {
    const current = this.requireRecord(id)
    const next: Tenant = { ...current, enabled }
    this.registry.update(next)
    try {
      await this.store?.upsert(next)
    } catch (error: unknown) {
      this.registry.update(current)
      throw this.provisionFailure('persist', error)
    }
    return next
  }

  /** Apply a membership rewrite to one tenant, mirroring registry + store. */
  private async withMembers(id: string, rewrite: (members: string[]) => string[]): Promise<string[]> {
    const current = this.requireRecord(id)
    const members = rewrite([...(current.members ?? [])])
    const next: Tenant = { ...current, members }
    this.registry.update(next)
    try {
      await this.store?.upsert(next)
    } catch (error: unknown) {
      this.registry.update(current)
      throw this.provisionFailure('persist', error)
    }
    return members
  }

  /** Provision one record's storage partition and host directories. */
  private async provision(record: Tenant): Promise<void> {
    try {
      await this.lifecycle?.provision(record.id)
      await this.bootstrapTenantDirs(record)
    } catch (error: unknown) {
      throw this.provisionFailure('provision', error)
    }
  }

  /** Create a tenant's host directories plus every member's host directories. */
  private async bootstrapTenantDirs(record: Tenant): Promise<void> {
    await this.mkdirAll(tenantDirectories({
      dataRoot: record.dataRoot,
      workspaceRoot: record.workspaceRoot,
      toolsRoot: record.toolsRoot,
      usersRoot: this.usersRoot,
      archiveRoot: this.archiveRoot,
      systemRoot: this.systemRoot,
      pythonRoot: this.pythonRoot,
      members: record.members,
    }))
  }

  /**
   * Create every directory a layout list names, each with its parents.
   *
   * @param dirs - the directories to create.
   */
  private async mkdirAll(dirs: readonly string[]): Promise<void> {
    await Promise.all(dirs.map(dir => fs.mkdir(dir, { recursive: true })))
  }

  /**
   * Create one subject's host directories: the per-tenant case workspace the
   * sandbox mounts at `/workspace`, and the `/global` tier directories under
   * `usersRoot`. Both are bind-mount sources, and Docker creates a missing
   * bind-mount source as an empty directory, so each is created here rather than
   * left to the sandbox start.
   *
   * @param subject - the JWT `sub` whose directories are created.
   * @param workspaceRoot - the admitting tenant's workspace root; absent only for
   *   {@link usersEnsure}, which prepares a subject no tenant has admitted yet and
   *   so has no per-tenant directory to name.
   */
  private async bootstrapUserDirs(subject: string, workspaceRoot?: string): Promise<void> {
    await this.mkdirAll(tenantDirectories({ workspaceRoot, usersRoot: this.usersRoot, members: [subject] }))
  }

  /**
   * Move a removed tenant's directories under the archive root, leaving data
   * intact. Both are moved into one timestamped slot, so a purge that archives
   * only one of them is not a state this leaves behind.
   */
  private async archiveDirs(record: Tenant): Promise<void> {
    const root = this.archiveRoot ?? join(record.dataRoot, '.archived')
    const stamp = `${String(record.id)}-${Date.now()}`
    await fs.mkdir(join(root, stamp), { recursive: true })
    const sources: Array<[label: string, source: string]> = [
      ['data', record.dataRoot],
      ['workspace', record.workspaceRoot],
    ]
    for (const [label, source] of sources) {
      await this.moveIntoArchive(source, join(root, stamp, label))
    }
  }

  /**
   * Move one directory into its slot under the archive root.
   *
   * `ENOENT` is the only code this absorbs: the slot's parent was just created,
   * so the failure can only mean the source directory is already gone, and a
   * purge of a tenant whose directory no longer exists still archives what does.
   * Every other code reaches the caller — `remove` answers `{ removed: true }`
   * only after this returns, so absorbing one would report a purge whose archive
   * never happened.
   *
   * `EXDEV` is a normal outcome here, not a fault: the archive root and a
   * tenant's roots are separate bind-mount sources of a containerized
   * deployment, and `rename(2)` refuses to link a directory across filesystems.
   * The move then degrades to the copy-and-delete `mv` performs on the same
   * input. The copy preserves file modes and timestamps and keeps symlinks
   * verbatim, so a relative link inside the tree still resolves at the archive
   * location; the source is removed only once the copy completes, so a copy that
   * fails partway leaves the tenant's data where it was.
   *
   * @param source - the tenant directory to move.
   * @param destination - its slot under the archive root, whose parent exists.
   */
  private async moveIntoArchive(source: string, destination: string): Promise<void> {
    try {
      await fs.rename(source, destination)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (code !== 'EXDEV') throw error
      await fs.cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
      await fs.rm(source, { recursive: true, force: true })
    }
  }

  /** Wrap a lifecycle or persistence failure with its stage, preserving the cause. */
  private provisionFailure(stage: 'provision' | 'persist', error: unknown): TenantAdminError {
    const message = error instanceof Error ? error.message : String(error)
    return new TenantAdminError('provision-failed', `tenant admin ${stage} failed: ${message}`)
  }

  /** Validate a create request and return the safe tenant id string. */
  private normalizeCreate(request: CreateTenantRequest): string {
    assertSafeSegment(request.id, 'tenant id')
    if (request.name.trim() === '') throw new TenantAdminError('invalid-input', 'tenant name must not be empty')
    if (request.dataRoot.trim() === '' || request.workspaceRoot.trim() === '') {
      throw new TenantAdminError('invalid-input', 'dataRoot and workspaceRoot must not be empty')
    }
    return request.id
  }
}

export default TenantAdmin
