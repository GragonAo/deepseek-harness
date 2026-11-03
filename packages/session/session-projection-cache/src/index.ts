/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every registered projection unit's state, one record per
 * session on the domain data form (`session_projcache` domain — the shipped
 * json backend lands it beside `workspace.json`). The cache is a fold
 * shortcut, never an authority: a row is possibly stale (its `seq`
 * says how stale) but never wrong, so every write path is fail-soft (a lost
 * write costs a longer tail replay on the next cold read) and a
 * `ver` mismatch discards the row instead of migrating it. Design
 * authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { currentPartition } from '@deepseek-ai/dsh-partition-scope'
import z from '@deepseek-ai/schemastery'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
// Empty type import: applies the package's cordis Context merge
// (`ctx.sessionPersistence`), which this service reads on the cold path.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionCheckpoint, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

export { checkpointIdentity, checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the two mandatory write points (`turn/end` and session
 * disposal) are policy, not tunables, and always fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
  /**
   * How many request partitions keep their domain loaded at once. A
   * partitioned deployment loads one table per (tenant, user) on first use —
   * every stored checkpoint of that partition — so the count is a memory
   * budget the deployment states: a single-partition deployment needs one, a
   * multi-tenant host needs as many partitions as it serves concurrently.
   * Loading another partition evicts the least recently used one and closes
   * its domain; a later use of an evicted partition reloads it from the
   * medium (its checkpoints are durable, so nothing is lost).
   */
  maxLoadedPartitions: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
  maxLoadedPartitions: z.natural().min(1).required(),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** One loaded partition: its domain's typed table plus the handle that releases it. */
interface LoadedPartition {
  readonly table: KvTable<SessionId, CheckpointRecord>
  readonly close: () => Promise<void>
}

/**
 * The persisted projection cache service. Loads the `session_projcache`
 * domain of the ambient request partition on first use (a partitioned
 * deployment keeps one domain per (tenant, user), bounded by
 * {@link Config.maxLoadedPartitions}), checkpoints live sessions on a
 * throttled write-behind (count/interval triggers from {@link Config}) plus
 * two mandatory points — `turn/end` and session disposal (the live-to-cold
 * moment) — and serves the cold-read ladder: cached row, persistence
 * `readFrom` tail, registry `restore`, durable write-back. Every durable
 * write is fail-soft: failures log a warning and the cache self-heals on the
 * next write or cold read.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessionPersistence', 'sessions']

  static Config: z<Config> = Config

  /** Loaded partitions by key, least recently used first (Map order is the eviction order). */
  private readonly partitions = new Map<string, Promise<LoadedPartition>>()
  private readonly dirty = new Map<Session, DirtyState>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Install the write-behind listeners. The domain is loaded on first use, not here. */
  protected [Service.init](): void {
    this.installWritePath()
  }

  /**
   * The ambient request partition's loaded domain. A miss loads that
   * partition's table (every stored checkpoint of that tenant and user) and
   * evicts the least recently used partition past the configured budget; a
   * concurrent second caller joins the in-flight load instead of opening the
   * domain twice (the facility rejects a double open).
   * @returns the partition's table and its release handle.
   */
  private async partition(): Promise<LoadedPartition> {
    const key = this.partitionKey()
    const held = this.partitions.get(key)
    if (held !== undefined) {
      // Re-insert: Map iteration order is the eviction order.
      this.partitions.delete(key)
      this.partitions.set(key, held)
      return held
    }
    const opening = this.openPartition()
    this.partitions.set(key, opening)
    opening.catch(() => {
      if (this.partitions.get(key) === opening) this.partitions.delete(key)
    })
    await this.evict(key)
    return opening
  }

  /**
   * The eviction key of the ambient partition: the same (tenant, user) pair
   * the storage backends address a schema by, and the bare empty string when
   * the deployment has no partition scope (single-partition deployments).
   * @returns the partition key.
   */
  private partitionKey(): string {
    const partition = currentPartition(this.ctx)
    if (partition === undefined) return ''
    const user = partition.userName
    return user === undefined ? partition.tenantName : `${partition.tenantName}.${user}`
  }

  /** Open one partition's domain from the plain (untyped) spec and bind its table. */
  private async openPartition(): Promise<LoadedPartition> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    return { table: domain.table('sessions'), close: () => domain.close() }
  }

  /**
   * Close the least recently used partitions until the budget holds, never
   * the partition the caller is about to use.
   * @param current - the partition key that must stay loaded.
   */
  private async evict(current: string): Promise<void> {
    for (const key of [...this.partitions.keys()]) {
      if (this.partitions.size <= this.config.maxLoadedPartitions) return
      if (key === current) continue
      const held = this.partitions.get(key)
      this.partitions.delete(key)
      if (held === undefined) continue
      await held.then(partition => partition.close()).catch((error: unknown) => {
        this.ctx.logger.warn(`session projection cache: closing an evicted partition's domain failed: ${String(error)}`)
      })
    }
  }

  /**
   * Close every loaded partition and drop the write-behind state with the
   * plugin (timers belong to sessions that outlive the cache).
   */
  private disposePartitions(): void {
    const held = [...this.partitions.values()]
    this.partitions.clear()
    for (const pending of held) {
      void pending
        .then(partition => partition.close())
        .catch((error: unknown) => {
          this.ctx.logger.warn(`session projection cache: closing a partition's domain failed: ${String(error)}`)
        })
    }
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private async recordFor(id: SessionId, expected: CheckpointIdentity): Promise<CheckpointRecord | undefined> {
    const record = (await this.partition()).table.get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * The listing read: whole values viewed straight from the stored rows
   * (version-matching keys only), each cut carried with its watermark so a
   * client value store can seed under its higher-seq-wins rule — as stale as
   * the last durable checkpoint but never wrong, and never from an unrelated
   * log (the caller's header is the identity witness). Costs no log read: the
   * first call in a partition loads that partition's table from the medium,
   * every later one reads the memory it holds. Fresher paths (the history
   * tail baseline, {@link coldSnapshot}) supersede these values whenever a
   * session is actually opened.
   * @param meta - the listed session's header (identity witness; no log read).
   * @returns the cut (`asOfSeq` = lowest served-row watermark), or
   *   `undefined` when no usable row exists for this lifecycle.
   */
  async cachedSnapshot(meta: SessionHeader): Promise<ProjectionSnapshot | undefined> {
    const record = await this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows)
    const keys = Object.keys(values)
    if (keys.length === 0) return undefined
    // The block carries ONE cut: the lowest served watermark is the seq every
    // value is at least current as of (under-claiming is safe under
    // higher-seq-wins; over-claiming would let a stale value outrank pushes).
    const asOfSeq = Math.min(...keys.map(key => (record.rows[key] as { seq: number }).seq))
    return { asOfSeq, values }
  }

  /**
   * Durably checkpoint one live session NOW (both mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references), then the whole record is
   * replaced. NOT fail-soft — callers on the fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    // Durability barrier: the checkpoint cut was taken above, so flushing
    // AFTER it guarantees every event inside the cut is durably logged
    // before the cache row lands — a crash can leave the cache behind the
    // log (longer tail replay) but never ahead of it (phantom values folded
    // from events no stored log contains). At detach the store entry is
    // already gone; persistence's own retirement drain covers that path and
    // any residual overreach is caught by the cold read's anchored floor.
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(session.id, identityOf(session.header), rows)
  }

  /**
   * Cold-read one persisted session's projections with zero full-log load:
   * cached rows + a persistence `readFrom` tail from the registry's restore
   * floor, refolded by the registry and written back (fail-soft) so the next
   * cold read starts closer. A cache row invalidated by a shrunk log
   * (crash-repair truncation) triggers one full re-read from seq 0 — the
   * ladder's slow rung, still no crash. Rejects when the session has no
   * persisted log (`not found` from the persistence seam).
   * @param id - the persisted session to read.
   * @param signal - optional cancellation for the persistence reads.
   * @returns the snapshot cut at the stored log end.
   */
  async coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot> {
    const record = (await this.partition()).table.get(id)
    const cached = record?.rows ?? {}
    const floor = this.ctx.sessionProjections.restoreFloor(cached)
    const persistence = this.ctx.sessionPersistence
    if (floor === undefined) {
      // No unit registered: nothing to fold, but the not-found contract must
      // hold in this topology too — the probe read rejects for an absent log
      // and dates the empty cut for a present one.
      const probe = await persistence.readFrom(id, 0, signal)
      return { asOfSeq: probe.events.at(-1)?.seq ?? -1, values: {} }
    }
    let restored: { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint }
    const tail = await persistence.readFrom(id, floor, signal)
    // The tail's stored header is the identity witness: a record bound to a
    // different lifecycle (recreated id, swapped store) is discarded whole
    // before any of its rows can seed a fold.
    const related = record === undefined || identityMatches(record.identity, identityOf(tail.meta))
    try {
      if (!related) throw new Error('unrelated log identity')
      restored = this.ctx.sessionProjections.restore(cached, tail.events, floor)
    } catch {
      // The recoverable restore failures: an unrelated record, or a row
      // overreaching the stored log end (or predating the floor). Both imply
      // floor > 0 (baseSeq-0 restores never throw and an unrelated record
      // still carried a usable watermark), so the full log is a fresh read.
      const whole = await persistence.readFrom(id, 0, signal)
      restored = this.ctx.sessionProjections.restore({}, whole.events, 0)
    }
    await this.putSoft(id, identityOf(tail.meta), restored.checkpoint, 'cold-read write-back')
    return restored.snapshot
  }

  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Detach (the live-to-cold moment): the second mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markClean) right after is safe.
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // Clear pending timers with the plugin (their sessions outlive the cache)
    // and release every loaded partition's domain.
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
      this.disposePartitions()
    }, 'sessionProjectionCache.timers')
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markClean clears the timer with
   * the counter) and the two mandatory points write unconditionally.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** Replace one session's stored record with its log identity and a detached snapshot of `rows`. */
  private async put(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    await (await this.partition()).table.put(id, { identity, rows: detached as CheckpointRecord['rows'] })
  }

  /** Fail-soft {@link put}: cache writes must never fail their caller's read or event path. */
  private async putSoft(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint, what: string): Promise<void> {
    try {
      await this.put(id, identity, rows)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${what} for "${id}" failed (cache stays stale): ${String(error)}`)
    }
  }


}

/** Project a header onto the identity fields a record is bound to. */
function identityOf(header: SessionHeader): CheckpointIdentity {
  return { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } }
}

/** Whether a stored record's bound identity names the caller's lifecycle. */
function identityMatches(stored: CheckpointIdentity, expected: CheckpointIdentity): boolean {
  return stored.createdAt === expected.createdAt && stored.cwd === expected.cwd
}

export default SessionProjectionCache
