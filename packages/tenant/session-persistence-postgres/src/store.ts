/**
 * (Tenant, user)-keyed PostgreSQL {@link PersistenceBackend}: one schema per
 * tenant hosts `session_meta` and `session_event`, whose `user_id` columns
 * keep each authenticated subject's log apart within the tenant schema. Reads
 * resolve the ambient tenant and user at call entry (cross-tenant and
 * cross-user ids are unaddressable by construction); writes capture the owning
 * (tenant, user) at materialize/load time so an asynchronous flush that
 * outlives the request still lands in the right schema and user.
 * @module @deepseek-ai/dsh-session-persistence-postgres/src/store
 */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { PersistenceBackend, SessionPersistenceSnapshot, StoredPrefix, StoredSuffix } from '@deepseek-ai/dsh-session-persistence'
import { currentTenant, currentUser, requireTenant, requireUser, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { TenantId, UserId } from '@deepseek-ai/dsh-tenant'
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
      for (const event of events) {
        await tx.query(
          `INSERT INTO ${schema}.session_event (id, user_id, seq, event) VALUES ($1, $2, $3, $4::jsonb)`,
          [meta.id, user, event.seq, encodeJson(event)],
        )
      }
      await tx.query(`UPDATE ${schema}.session_meta SET revision = revision + 1 WHERE id = $1`, [meta.id])
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
      for (const event of closers) {
        await tx.query(
          `INSERT INTO ${schema}.session_event (id, user_id, seq, event) VALUES ($1, $2, $3, $4::jsonb)`,
          [meta.id, user, event.seq, encodeJson(event)],
        )
      }
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
    })
    this.bindings.delete(id)
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

  private ensureSchema(schema: string): Promise<void> {
    const existing = this.ensuredSchemas.get(schema)
    if (existing !== undefined) return existing
    const pending = this.materializeSchema(schema)
    this.ensuredSchemas.set(schema, pending)
    pending.catch(() => this.ensuredSchemas.delete(schema))
    return pending
  }

  private async materializeSchema(schema: string): Promise<void> {
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
