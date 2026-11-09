/**
 * (Tenant, user)-keyed PostgreSQL {@link PersistenceBackend}: one schema per
 * tenant hosts `session_meta` and `session_event`, whose `user_id` columns
 * keep each authenticated subject's log apart within the tenant schema. Reads
 * resolve the ambient tenant and user at call entry (cross-tenant and
 * cross-user ids are unaddressable by construction); writes capture the owning
 * (tenant, user) at materialize/load time so an asynchronous flush that
 * outlives the request still lands in the right schema and user.
 *
 * The same store maintains `session_index`, one platform-level row per session
 * carrying the session-list facts (started, last question time) in the
 * transaction that appends the events that advance them, so a subject's
 * figures across every tenant are one indexed read instead of one log walk per
 * tenant. The rows are a view of the logs: {@link PostgresSessionStore.reindex}
 * rebuilds them from a tenant's partitions.
 * @module @deepseek-ai/dsh-session-persistence-postgres/src/store
 */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { PersistenceBackend, SessionIndexStats, SessionPersistenceSnapshot, StoredPrefix, StoredSuffix } from '@deepseek-ai/dsh-session-persistence'
import { currentTenant, currentUser, requireTenant, requireUser, TenantId, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { UserId } from '@deepseek-ai/dsh-tenant'
import type { SqlExecutor } from './executor.ts'

/** JSON-encode an opaque value for a `::jsonb` column. */
function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value) as string | undefined
  if (encoded === undefined) {
    throw new Error('session-persistence-postgres: value is not JSON-serializable')
  }
  return encoded
}

/** Rebuild the stored revision token from its durable parts. */
function revisionOf(schema: string, id: SessionId, revision: unknown): SessionPersistenceRevision {
  return SessionPersistenceRevision(`${schema}:${id}:${String(revision)}`)
}

/** Rebuild a {@link SessionHeader} from one `session_meta` row. */
function headerFromRow(row: Record<string, unknown>): SessionHeader {
  const base = {
    version: row.version as number,
    id: row.id as SessionId,
    createdAt: Number(row.created_at),
  }
  return {
    ...base,
    ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
    ...(typeof row.parent_session === 'string' ? { parentSession: row.parent_session as SessionId } : {}),
    ...(typeof row.seed_length === 'number' ? { seedLength: row.seed_length } : {}),
    ...(row.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof row.delegation_depth === 'number' ? { delegationDepth: row.delegation_depth } : {}),
    ...(typeof row.agent_preset === 'string' ? { agentPreset: row.agent_preset } : {}),
  }
}

const META_COLUMNS = 'id, user_id, tenant_id, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset'

/**
 * Events per multi-row INSERT statement (4 parameters each, far inside the wire
 * protocol's limit). A flush of live events is one round trip per chunk instead
 * of one per event: a streaming turn emits a chunk event per token, so a
 * per-event statement turns one busy turn into thousands of sequential round
 * trips that compete with every other request on the same event loop.
 */
const EVENT_ROWS_PER_STATEMENT = 200

/**
 * The conversation index, one row per session. It lives beside `tenant_record`
 * in the connection's own schema rather than inside a tenant partition: a
 * subject's figures span tenants, and a per-partition table could only answer
 * one tenant at a time.
 */
const INDEX_TABLE = 'session_index'

/**
 * The index facts one appended batch advances: `turn/start` makes a session a
 * conversation, and a `user/message` whose source is the human prompt dates its
 * last question. Both rules are the session-list fold, so the index and the
 * list cannot disagree about what counts.
 * @param events - the batch's events, in seq order.
 * @returns the advanced facts, or `undefined` when the batch advances none.
 */
function indexAdvance(events: readonly SessionEvent[]): { started: boolean; lastPromptAt: number | null } | undefined {
  let started = false
  let lastPromptAt: number | null = null
  for (const event of events) {
    if (event.type === 'turn/start') started = true
    else if (event.type === 'user/message' && event.data.source.kind === 'user') lastPromptAt = event.time
  }
  return started || lastPromptAt !== null ? { started, lastPromptAt } : undefined
}

/**
 * The PostgreSQL session store. Implements {@link PersistenceBackend} with
 * rows of full-JSON events; `appendBatch` and `commitRepair` run in a single
 * transaction, so no torn tail exists and {@link StoredPrefix.tornMarker} is
 * never present.
 */
export class PostgresSessionStore implements PersistenceBackend<never> {
  readonly name = 'postgres'

  /** Session-id → owning (tenant, user), captured at materialize or a successful read. */
  private readonly bindings = new Map<SessionId, { tenant: TenantId; user: UserId }>()
  /** Deferred schema materializations, memoized per schema name. */
  private readonly ensuredSchemas = new Map<string, Promise<void>>()
  /** The one-process index-table materialization, memoized until it succeeds. */
  private ensuredIndex: Promise<void> | undefined

  constructor(readonly executor: SqlExecutor) {}

  // --- Reads (ambient-tenant scoped) ---

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted()
    const tenant = requireTenant()
    const user = requireUser()
    const schema = tenantPartitionName(tenant.id)
    await this.ensureSchema(schema)
    const metaRows = await this.executor.query(
      `SELECT ${META_COLUMNS}, revision FROM ${schema}.session_meta WHERE id = $1 AND user_id = $2`,
      [id, user],
    )
    const metaRow = metaRows[0]
    if (metaRow === undefined) return undefined
    this.assertTenantAgreement(metaRow, tenant.id)
    this.bindings.set(id, { tenant: tenant.id, user })
    const eventRows = await this.executor.query(
      `SELECT event FROM ${schema}.session_event WHERE id = $1 AND user_id = $2 ORDER BY seq`,
      [id, user],
    )
    const events = eventRows.map(row => row.event as SessionEvent)
    const meta = headerFromRow(metaRow)
    return { meta, events, revision: revisionOf(schema, id, metaRow.revision) }
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const tenant = requireTenant()
    const user = requireUser()
    const schema = tenantPartitionName(tenant.id)
    await this.ensureSchema(schema)
    const rows = await this.executor.query(
      `SELECT revision FROM ${schema}.session_meta WHERE id = $1 AND user_id = $2`,
      [id, user],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    this.bindings.set(id, { tenant: tenant.id, user })
    return revisionOf(schema, id, row.revision)
  }

  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const tenant = requireTenant()
    const user = requireUser()
    const schema = tenantPartitionName(tenant.id)
    await this.ensureSchema(schema)
    const metaRows = await this.executor.query(
      `SELECT ${META_COLUMNS} FROM ${schema}.session_meta WHERE id = $1 AND user_id = $2`,
      [id, user],
    )
    const metaRow = metaRows[0]
    if (metaRow === undefined) return undefined
    this.assertTenantAgreement(metaRow, tenant.id)
    this.bindings.set(id, { tenant: tenant.id, user })
    const eventRows = await this.executor.query(
      `SELECT event FROM ${schema}.session_event WHERE id = $1 AND user_id = $2 AND seq >= $3 ORDER BY seq`,
      [id, user, fromSeq],
    )
    return { meta: headerFromRow(metaRow), events: eventRows.map(row => row.event as SessionEvent) }
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const tenant = currentTenant()
    const user = currentUser()
    // A boot-time global sweep (the single-user workspace registry's history
    // bootstrap) has no request tenant or user; it indexes nothing rather than
    // failing the whole boot. Returns the empty list — no tenant's or user's
    // data leaks — while per-id reads stay `requireTenant`/`requireUser`-gated.
    if (tenant === undefined || user === undefined) return []
    const schema = tenantPartitionName(tenant.id)
    await this.ensureSchema(schema)
    const rows = await this.executor.query(
      `SELECT ${META_COLUMNS} FROM ${schema}.session_meta WHERE user_id = $1 ORDER BY created_at`,
      [user],
    )
    return rows.map(headerFromRow)
  }

  /**
   * List every stored snapshot across the ambient (tenant, user), newest
   * metadata first.
   * @param signal - aborts the discovery before it runs.
   * @returns the user's session snapshots, each with its durable revision.
   */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const tenant = currentTenant()
    const user = currentUser()
    if (tenant === undefined || user === undefined) return []
    const schema = tenantPartitionName(tenant.id)
    await this.ensureSchema(schema)
    const rows = await this.executor.query(
      `SELECT ${META_COLUMNS}, revision FROM ${schema}.session_meta WHERE user_id = $1 ORDER BY created_at`,
      [user],
    )
    return rows.map(row => ({
      header: headerFromRow(row),
      revision: revisionOf(schema, row.id as SessionId, row.revision),
    }))
  }

  // --- Writes (owning-tenant bound) ---

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    const { tenant, user } = this.owningScope(meta.id, isMaterialized)
    const schema = tenantPartitionName(tenant)
    await this.ensureSchema(schema)
    await this.executor.transaction(async (tx) => {
      if (!isMaterialized) {
        await tx.query(
          `INSERT INTO ${schema}.session_meta (${META_COLUMNS}, revision) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0)`,
          [
            meta.id,
            user,
            tenant,
            meta.version,
            meta.createdAt,
            meta.cwd ?? null,
            meta.parentSession ?? null,
            meta.seedLength ?? null,
            meta.origin ?? null,
            meta.delegationDepth ?? null,
            meta.agentPreset ?? null,
          ],
        )
      }
      await this.insertEvents(tx, schema, meta.id, user, events)
      await tx.query(`UPDATE ${schema}.session_meta SET revision = revision + 1 WHERE id = $1`, [meta.id])
      const advance = indexAdvance(events)
      // A materialization always seeds the row, so a session the index has
      // never seen gets one even when its first batch starts no turn; a later
      // batch writes only when it advances a fact.
      if (!isMaterialized) await this.upsertIndex(tx, tenant, user, meta, advance ?? { started: false, lastPromptAt: null })
      else if (advance !== undefined) await this.upsertIndex(tx, tenant, user, meta, advance)
    })
    if (!isMaterialized) this.bindings.set(meta.id, { tenant, user })
  }

  async commitRepair(
    meta: SessionHeader,
    _tornMarker: undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (closers.length === 0) return
    const { tenant, user } = this.owningScope(meta.id, true)
    const schema = tenantPartitionName(tenant)
    await this.ensureSchema(schema)
    await this.executor.transaction(async (tx) => {
      await this.insertEvents(tx, schema, meta.id, user, closers)
      await tx.query(`UPDATE ${schema}.session_meta SET revision = revision + 1 WHERE id = $1`, [meta.id])
    })
  }

  async close(): Promise<void> {
    await this.executor.close()
  }

  /**
   * Delete one session's durable footprint: its `session_event` rows and its
   * `session_meta` row, in one transaction, then the captured binding. Both
   * deletes are scoped to the owning (tenant, user) like every other write, so
   * the captured binding is used when a load materialized the session earlier
   * in this process and the ambient scope otherwise. Deleting an absent session
   * is a no-op.
   * @param id - the persisted session to remove.
   * @param signal - aborts before the transaction runs.
   */
  async remove(id: SessionId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const { tenant, user } = this.owningScope(id, true)
    const schema = tenantPartitionName(tenant)
    await this.ensureSchema(schema)
    await this.executor.transaction(async (tx) => {
      await tx.query(`DELETE FROM ${schema}.session_event WHERE id = $1 AND user_id = $2`, [id, user])
      await tx.query(`DELETE FROM ${schema}.session_meta WHERE id = $1 AND user_id = $2`, [id, user])
      await tx.query(
        `DELETE FROM ${INDEX_TABLE} WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`,
        [tenant, user, id],
      )
    })
    this.bindings.delete(id)
  }


  // --- Conversation index (platform-level) ---

  /**
   * Read one subject's conversation figures across every tenant. Unlike the
   * ambient-scoped reads above, this one names its subject: the index exists so
   * a management surface can answer for a user it is not authenticated as.
   * @param user - the subject whose figures to read.
   * @returns one entry per tenant that subject has conversations in, ordered by tenant id.
   */
  async statsOf(user: string): Promise<SessionIndexStats[]> {
    await this.ensureIndex()
    const rows = await this.executor.query(
      `SELECT tenant_id,
              count(*) AS session_count,
              max(last_prompt_at) AS last_prompt_at,
              max(GREATEST(created_at, last_prompt_at)) AS updated_at
       FROM ${INDEX_TABLE}
       WHERE user_id = $1 AND started AND parent_session IS NULL AND origin IS DISTINCT FROM 'subagent'
       GROUP BY tenant_id
       ORDER BY tenant_id`,
      [user],
    )
    return rows.map(row => ({
      tenant: String(row.tenant_id),
      sessionCount: Number(row.session_count),
      lastPromptAt: row.last_prompt_at === null || row.last_prompt_at === undefined
        ? null
        : Number(row.last_prompt_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  /**
   * Rebuild one tenant's index rows from its stored partitions: sessions
   * written before the index existed have no row, and neither has any written
   * by a process that crashed between the append and its index write. The
   * rebuild folds the stored log exactly as the append path does; a row already
   * advanced is left advanced.
   * @param tenant - the tenant id whose partitions to fold.
   * @returns how many rows the rebuild wrote.
   */
  async reindex(tenant: string): Promise<number> {
    await this.ensureIndex()
    const schema = tenantPartitionName(TenantId(tenant))
    await this.ensureSchema(schema)
    const rows = await this.executor.query(
      `INSERT INTO ${INDEX_TABLE} (tenant_id, user_id, session_id, created_at, started, last_prompt_at, parent_session, origin, updated_at)
       SELECT m.tenant_id, m.user_id, m.id, m.created_at,
              EXISTS (
                SELECT 1 FROM ${schema}.session_event e
                WHERE e.id = m.id AND e.user_id = m.user_id AND e.event->>'type' = 'turn/start'
              ),
              (
                SELECT max((e.event->>'time')::bigint) FROM ${schema}.session_event e
                WHERE e.id = m.id AND e.user_id = m.user_id AND e.event->>'type' = 'user/message'
                  AND e.event->'data'->'source'->>'kind' = 'user'
              ),
              m.parent_session, m.origin, $1
       FROM ${schema}.session_meta m
       ON CONFLICT (tenant_id, user_id, session_id) DO UPDATE SET
         started = ${INDEX_TABLE}.started OR EXCLUDED.started,
         last_prompt_at = GREATEST(${INDEX_TABLE}.last_prompt_at, EXCLUDED.last_prompt_at),
         updated_at = EXCLUDED.updated_at
       RETURNING session_id`,
      [Date.now()],
    )
    return rows.length
  }

  // --- Internal ---

  /**
   * Resolve the (tenant, user) that owns a session id for a write.
   * Materialization captures the ambient (authenticated) tenant and user;
   * later writes reuse the captured binding so an asynchronous flush that
   * outlives the request still targets the same schema and user, and falls
   * back to the ambient scope for request-scoped repair of a session this
   * process never materialized.
   */
  private owningScope(id: SessionId, isMaterialized: boolean): { tenant: TenantId; user: UserId } {
    if (isMaterialized) {
      const bound = this.bindings.get(id)
      if (bound !== undefined) return bound
    }
    return { tenant: requireTenant().id, user: requireUser() }
  }

  private assertTenantAgreement(row: Record<string, unknown>, tenantId: TenantId): void {
    if (row.tenant_id !== tenantId) {
      throw new Error(`session tenant_id '${String(row.tenant_id)}' disagrees with the ambient tenant '${tenantId}'; refuse to load`)
    }
  }

  /**
   * Append events as multi-row INSERTs, splitting into statements of
   * {@link EVENT_ROWS_PER_STATEMENT} rows. Runs on the caller's transaction, so a
   * flush stays all-or-nothing across its chunks.
   * @param tx - the flush's transaction-scoped executor.
   * @param schema - the tenant partition schema.
   * @param id - the session id every row is keyed by.
   * @param user - the owning user id every row is keyed by.
   * @param events - the events to append, in seq order.
   */
  private async insertEvents(
    tx: SqlExecutor,
    schema: string,
    id: SessionId,
    user: UserId,
    events: readonly SessionEvent[],
  ): Promise<void> {
    for (let start = 0; start < events.length; start += EVENT_ROWS_PER_STATEMENT) {
      const values: unknown[] = []
      const rows = events.slice(start, start + EVENT_ROWS_PER_STATEMENT).map((event, index) => {
        const base = index * 4
        values.push(id, user, event.seq, encodeJson(event))
        return `($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(base + 4)}::jsonb)`
      })
      await tx.query(
        `INSERT INTO ${schema}.session_event (id, user_id, seq, event) VALUES ${rows.join(', ')}`,
        values,
      )
    }
  }

  /**
   * Write one session's index facts on the caller's transaction, so the row
   * commits with the events that produced it. `started` only ever turns true
   * and the question time only ever moves forward, which keeps a replayed or
   * out-of-order batch from walking a row backwards.
   * @param tx - the flush's transaction-scoped executor.
   * @param tenant - the owning tenant.
   * @param user - the owning subject.
   * @param meta - the session header the row is keyed by.
   * @param advance - the facts this batch advances.
   */
  private async upsertIndex(
    tx: SqlExecutor,
    tenant: TenantId,
    user: UserId,
    meta: SessionHeader,
    advance: { started: boolean; lastPromptAt: number | null },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ${INDEX_TABLE} (tenant_id, user_id, session_id, created_at, started, last_prompt_at, parent_session, origin, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, user_id, session_id) DO UPDATE SET
         started = ${INDEX_TABLE}.started OR EXCLUDED.started,
         last_prompt_at = GREATEST(${INDEX_TABLE}.last_prompt_at, EXCLUDED.last_prompt_at),
         updated_at = EXCLUDED.updated_at`,
      [
        tenant,
        user,
        meta.id,
        meta.createdAt,
        advance.started,
        advance.lastPromptAt,
        meta.parentSession ?? null,
        meta.origin ?? null,
        Date.now(),
      ],
    )
  }

  private ensureIndex(): Promise<void> {
    const existing = this.ensuredIndex
    if (existing !== undefined) return existing
    const pending = this.materializeIndex()
    this.ensuredIndex = pending
    pending.catch(() => { this.ensuredIndex = undefined })
    return pending
  }

  /**
   * Create the shared index table once per process. Every tenant schema
   * materialization ensures it too, so a deployment that only ever writes
   * through the append path never issues a second one.
   */
  private async materializeIndex(): Promise<void> {
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${INDEX_TABLE} (
      tenant_id text NOT NULL,
      user_id text NOT NULL,
      session_id text NOT NULL,
      created_at bigint NOT NULL,
      started boolean NOT NULL DEFAULT false,
      last_prompt_at bigint,
      parent_session text,
      origin text,
      updated_at bigint NOT NULL,
      PRIMARY KEY (tenant_id, user_id, session_id)
    )`)
    await this.executor.query(`CREATE INDEX IF NOT EXISTS ${INDEX_TABLE}_user ON ${INDEX_TABLE} (user_id)`)
  }

  private ensureSchema(schema: string): Promise<void> {
    const existing = this.ensuredSchemas.get(schema)
    if (existing !== undefined) return existing
    const pending = this.materializeSchema(schema)
    this.ensuredSchemas.set(schema, pending)
    pending.catch(() => this.ensuredSchemas.delete(schema))
    return pending
  }

  private async materializeSchema(schema: string): Promise<void> {
    await this.ensureIndex()
    await this.executor.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${schema}.session_meta (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      tenant_id text NOT NULL,
      version integer NOT NULL,
      created_at bigint NOT NULL,
      cwd text,
      parent_session text,
      seed_length integer,
      origin text,
      delegation_depth integer,
      agent_preset text,
      revision bigint NOT NULL DEFAULT 0
    )`)
    await this.executor.query(`CREATE TABLE IF NOT EXISTS ${schema}.session_event (
      id text NOT NULL,
      user_id text NOT NULL,
      seq bigint NOT NULL,
      event jsonb NOT NULL,
      PRIMARY KEY (id, seq)
    )`)
  }
}
