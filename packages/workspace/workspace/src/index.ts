/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 *
 * A partitioned deployment keys the registry by request partition:
 * `[Service.init]` runs outside any request and leaves the registry
 * lazily-uninitialized when no partition is ambient (a partition-keyed storage
 * backend rejects the partitionless open, and that is the expected fail-closed
 * boot signal). The first access inside a partition carrying a tenant and a
 * user opens that partition's domain, runs the one-time history bootstrap, and
 * rebuilds that partition's projected cache; a later access under a different
 * tenant or user switches to that partition's own state, so two tenants or two
 * users of one tenant never share a projection. Single-partition deployments
 * still initialize eagerly at boot under one partitionless state.
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { currentPartition, isPartitionlessFailure } from '@deepseek-ai/dsh-partition-scope'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceMoveInvalidError } from './entity.ts'
import { realpathNormalize } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'

export type { Workspace } from './types.ts'
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
export { realpathNormalize } from './paths.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * An archiveSession request named a session neither live nor in session
 * persistence — a definite miss only; storage faults propagate as themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

/** The registry's mutable state for one request partition (or the partitionless state). */
interface PartitionState {
  table: KvTable<WorkspaceId, WorkspaceRecord>
  global: DomainGlobal<WorkspaceDomainState>
  state: WorkspaceDomainState
  entities: Map<WorkspaceId, WorkspaceEntity>
  headers: Map<SessionId, SessionHeader>
  sessionPaths: Map<SessionId, string>
  invalidSessionPaths: Map<SessionId, string>
  host: WorkspaceEntityHost
  operationTail: Promise<void>
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one canonical-cwd header index, and completes the one-time history
 * bootstrap before the service becomes active. The persistence dependency is
 * mandatory so an unavailable peer can never be mistaken for an empty
 * history and commit the initialized marker. Every partition's state is keyed
 * by its request-partition key (`undefined` for the partitionless state); see
 * the module JSDoc for the partitioned lazy/partition-switch contract.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  /** Per-partition registry state, keyed by request-partition key (`undefined` for the partitionless state). */
  private readonly partitions = new Map<string | undefined, PartitionState>()
  /** In-flight per-partition initializations, memoized so concurrent first accesses share one open. */
  private readonly pending = new Map<string | undefined, Promise<PartitionState>>()
  /** Set once `[Service.init]` completes; a registry that never started rejects like before. */
  private started = false

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /**
   * Initialize the boot-time partition. Outside a request partition a
   * partition-keyed backend rejects the open with `NO_TENANT_IN_SCOPE`, which is
   * the expected partitioned-boot signal: stay lazily-uninitialized with an
   * empty projection instead of writing an initialized marker with no partition.
   * Any other failure (including single-partition bootstrap failures) propagates.
   */
  protected async [Service.init](): Promise<void> {
    this.started = true
    try {
      await this.initializePartition(this.currentKey())
    } catch (error) {
      if (isPartitionlessFailure(error)) return
      throw error
    }
  }

  /**
   * Create or reuse a workspace for an existing directory. The path is
   * canonicalized through `fs.realpath`; a nonexistent path rejects with the
   * original error and a non-directory rejects. Repeated calls for the same
   * canonical path return the existing entity without changing its title.
   * A newly created workspace is prepended to the durable registry order.
   * Different canonical paths may share a display title.
   * @param path - Existing directory to own, in any path spelling.
   * @param title - Display title used only when a new record is created.
   * @returns the existing or newly durable workspace.
   */
  // TODO: `title` lost its last production caller when the gateway's
  // create-by-name branch was deleted
  // (.agents/notes/implemented/simplification/2026-07-31-one-route-to-add-a-workspace.md);
  // drop the parameter with its @param clause and the `create(path, title?)`
  // lines in this package's README pair.
  async create(path: string, title?: string): Promise<Workspace> {
    const state = await this.ensurePartitionState()
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(state, () => this.createCanonical(state, canonical, title))
  }

  /**
   * Look up a workspace by id for the ambient request partition. Uninitialized
   * partitions serve `undefined` (no cross-partition leak).
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown or uninitialized.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.currentState()?.entities.get(id)
  }

  /**
   * Synchronous workspace projection for the ambient request partition in
   * durable registry order. An uninitialized partition (partitioned boot, or a
   * partition whose domain has not yet been opened) projects as empty rather
   * than failing. Every entity's `sessionIds` getter is already filtered by the
   * startup/live canonical-cwd header index; this method performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    const state = this.currentState()
    if (state === undefined) {
      this.assertStarted()
      return []
    }
    return state.state.workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The durable order is updated before the table deletion; a
   * failed table write restores the prior order and keeps the entity
   * published. Unknown ids are an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  async delete(id: WorkspaceId): Promise<boolean> {
    const state = await this.ensurePartitionState()
    return this.enqueueOperation(state, () => this.deleteKnown(state, id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  async insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    const state = await this.ensurePartitionState()
    return this.enqueueOperation(state, async () => {
      const current = state.state
      if (!current.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !current.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return current.workspaceIds
      const without = current.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, current.workspaceIds)) return current.workspaceIds
      await this.setState(state, { ...current, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * The ambient request partition's registry-global archive set: sessions hidden from
   * every grouping surface. Archiving never touches workspace accounting — an
   * archived session keeps its `sessionIds` slot so unarchiving restores its
   * position. An uninitialized partition projects empty.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    const state = this.currentState()
    if (state === undefined) {
      this.assertStarted()
      return []
    }
    return state.state.archivedSessionIds
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting — or lack of one — is irrelevant.
   * An already archived id resolves without writing.
   * @param sessionId - The session to archive.
   * @returns resolution after durability.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    const state = await this.ensurePartitionState()
    return this.enqueueOperation(state, async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (state.state.archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(state, sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId)
      }
      const current = state.state
      await this.setState(state, { ...current, archivedSessionIds: [...current.archivedSessionIds, sessionId] })
    })
  }

  /**
   * Resolve by canonical directory path without creating or mutating a
   * workspace. A missing path rejects during `realpath`; an existing unowned
   * directory returns `undefined`.
   * @param path - Existing directory path in any spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const state = await this.ensurePartitionState()
    const canonical = await realpathNormalize(path)
    for (const entity of state.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  /**
   * Whether a session is live, header-indexed, or present in a fresh
   * persistence listing. Only a definite miss returns false — a failing
   * `sessionPersistence.list()` propagates so storage faults never
   * masquerade as an unknown session.
   */
  private async sessionKnown(state: PartitionState, id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (state.headers.has(id)) return true
    await this.indexHeaders(state, await this.ctx.sessionPersistence.list())
    return state.headers.has(id)
  }

  /** Resolve the ambient request-partition key (`undefined` for a single-partition deployment). */
  private currentKey(): string | undefined {
    const partition = currentPartition(this.ctx)
    const user = partition?.userName
    if (partition === undefined || user === undefined) return undefined
    return `${partition.tenantName}.${user}`
  }

  /** The ambient partition's registry state, or `undefined` when not yet opened. */
  private currentState(): PartitionState | undefined {
    return this.partitions.get(this.currentKey())
  }

  /** Throw the pre-init error only for a registry that never started. */
  private assertStarted(): void {
    if (!this.started) throw new Error('workspace registry is not started yet')
  }

  /**
   * Resolve (opening, memoizing, and bootstrapping) the ambient partition's state.
   * @returns the ambient partition's initialized registry state.
   */
  private async ensurePartitionState(): Promise<PartitionState> {
    const key = this.currentKey()
    const existing = this.partitions.get(key)
    if (existing !== undefined) return existing
    if (!this.started) throw new Error('workspace registry is not started yet')
    const inflight = this.pending.get(key)
    if (inflight !== undefined) return await inflight
    const init = this.initializePartition(key)
    this.pending.set(key, init)
    try {
      return await init
    } finally {
      this.pending.delete(key)
    }
  }

  /**
   * Open one request partition's domain and complete its history bootstrap. The
   * opened domain, its table/global handles, the projected entity cache,
   * header index, and the host are all stored under that partition key.
   */
  private async initializePartition(key: string | undefined): Promise<PartitionState> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    const state: PartitionState = {
      table: domain.table('workspaces'),
      global: domain.global,
      state: domain.global.get(),
      entities: new Map(),
      headers: new Map(),
      sessionPaths: new Map(),
      invalidSessionPaths: new Map(),
      host: {
        table: () => state.table,
        sessionPath: id => state.sessionPaths.get(id),
        readSessionHeader: id => this.readSessionHeader(state, id),
        rememberSessionPath: (id, path) => {
          state.sessionPaths.set(id, path)
          state.invalidSessionPaths.delete(id)
        },
      },
      operationTail: Promise.resolve(),
    }
    this.partitions.set(key, state)
    try {
      await this.recoverPendingMutation(state)
      this.validateStoredState(state)
      if (!state.state.initialized) {
        const headers = await this.ctx.sessionPersistence.list()
        await this.replaceHeaderIndex(state, headers)
        await this.bootstrap(state, headers)
      } else if (state.table.size > 0) {
        await this.replaceHeaderIndex(state, await this.ctx.sessionPersistence.list())
      }

      await this.indexLiveSessions(state)
      this.validateStoredState(state)
      this.rebuildEntities(state)
      this.reportFilteredCandidates(state)
      return state
    } catch (error) {
      this.partitions.delete(key)
      throw error
    }
  }

  private async createCanonical(state: PartitionState, canonical: string, title?: string): Promise<WorkspaceEntity> {
    for (const entity of state.entities.values()) {
      if (entity.path === canonical) return entity
    }

    const workspaceName = title ?? basename(canonical)
    const table = state.table
    const current = state.state
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: workspaceName,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(state.host, id, record)
    state.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...current,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(state, pendingState)
    } catch (error) {
      state.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      state.entities.delete(id)
      try {
        await this.setState(state, current)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState(state, {
        initialized: true,
        workspaceIds: [id, ...current.workspaceIds],
        archivedSessionIds: current.archivedSessionIds,
      })
    } catch (error) {
      state.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state, current)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(state: PartitionState, id: WorkspaceId): Promise<boolean> {
    const entity = state.entities.get(id)
    if (entity === undefined) return false
    const current = state.state
    const nextState = {
      initialized: true,
      workspaceIds: current.workspaceIds.filter(workspaceId => workspaceId !== id),
      archivedSessionIds: current.archivedSessionIds,
    }
    await this.setState(state, {
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    state.entities.delete(id)
    try {
      await state.table.delete(id)
    } catch (error) {
      state.entities.set(id, entity)
      try {
        await this.setState(state, current)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        state.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(state, nextState)
    } catch (error) {
      // The deletion committed at the table write and was already published
      // to Host streams. Keep the durable marker for startup recovery rather
      // than reporting failure after the requested state became true.
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Unexplained
   * order/table divergence still reaches {@link validateStoredState} and
   * fails loud; this path never guesses which operation created a row from its shape alone.
   */
  private async recoverPendingMutation(state: PartitionState): Promise<void> {
    const current = state.state
    const pending = current.pendingMutation
    if (pending === undefined) return
    if (current.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await state.table.delete(pending.workspaceId)
    await this.setState(state, {
      initialized: current.initialized,
      workspaceIds: current.workspaceIds,
      archivedSessionIds: current.archivedSessionIds,
    })
  }

  private async bootstrap(state: PartitionState, headers: readonly SessionHeader[]): Promise<void> {
    const table = state.table
    const current = state.state
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = state.sessionPaths.get(header.id)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const byPath = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byPath.set(record.path, id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      let id = byPath.get(group.path)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = WorkspaceId(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          path: group.path,
          title: basename(group.path),
          sessionIds,
          createdAt,
          updatedAt: createdAt,
        }
        await table.put(id, record)
        byPath.set(group.path, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const currentRecord = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined || accounted.get(sessionId) === id)
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...currentRecord.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(currentRecord.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [group.path, group.newestAt]))
    const priorRank = new Map(current.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    if (!sameIds(current.workspaceIds, workspaceIds)) {
      await this.setState(state, { initialized: false, workspaceIds, archivedSessionIds: current.archivedSessionIds })
    }
    await this.setState(state, { initialized: true, workspaceIds, archivedSessionIds: current.archivedSessionIds })
  }

  private validateStoredState(state: PartitionState): void {
    const table = state.table
    const order = new Set<WorkspaceId>()
    for (const id of state.state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const pathHolder = paths.get(record.path)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(record.path, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(state: PartitionState): void {
    state.entities.clear()
    for (const id of state.state.workspaceIds) {
      const record = state.table.get(id) as WorkspaceRecord
      state.entities.set(id, new WorkspaceEntity(state.host, id, record))
    }
  }

  private async replaceHeaderIndex(state: PartitionState, headers: readonly SessionHeader[]): Promise<void> {
    state.headers.clear()
    state.sessionPaths.clear()
    state.invalidSessionPaths.clear()
    await this.indexHeaders(state, headers)
  }

  private async indexHeaders(state: PartitionState, headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(state, header)
  }

  private async indexHeader(state: PartitionState, header: SessionHeader): Promise<void> {
    state.headers.set(header.id, header)
    state.sessionPaths.delete(header.id)
    if (header.cwd === undefined) {
      state.invalidSessionPaths.set(header.id, 'header has no cwd')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        state.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      state.sessionPaths.set(header.id, path)
      state.invalidSessionPaths.delete(header.id)
    } catch {
      state.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  private async indexLiveSessions(state: PartitionState): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(state, sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(state: PartitionState): void {
    for (const entity of state.entities.values()) {
      const record = state.table.get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        const path = state.sessionPaths.get(sessionId)
        if (path === record.path) continue
        const reason = state.invalidSessionPaths.get(sessionId)
          ?? (state.headers.has(sessionId)
            ? `canonical cwd '${path}' differs from workspace path '${record.path}'`
            : 'session header is missing')
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(state: PartitionState, id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      state.headers.set(id, live.header)
      return live.header
    }
    const cached = state.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.ctx.sessionPersistence.list()
    await this.indexHeaders(state, headers)
    const header = state.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  /** The ambient partition's entity cache (single-user tests reach it via internals). */
  private get entities(): Map<WorkspaceId, WorkspaceEntity> {
    const state = this.currentState()
    if (state === undefined) throw new Error('workspace registry is not started yet')
    return state.entities
  }

  private async setState(state: PartitionState, value: WorkspaceDomainState): Promise<void> {
    await state.global.set(value)
    state.state = value
  }

  private enqueueOperation<T>(state: PartitionState, operation: () => Promise<T>): Promise<T> {
    const result = state.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation(state)
      return await operation()
    })
    state.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export default WorkspaceRegistry
