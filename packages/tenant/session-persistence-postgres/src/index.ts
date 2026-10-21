/**
 * Opt-in tenant-keyed PostgreSQL persistence provider. Logical sessions remain
 * unchanged; the physical backend stores each session's header in
 * `session_meta` and its events as full-JSON rows in `session_event`, both
 * inside a per-tenant schema.
 * @module @deepseek-ai/dsh-session-persistence-postgres
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionPreparation,
} from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionInspection,
  SessionLocation,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { PostgresSessionStore } from './store.ts'
import type { SqlExecutor } from './executor.ts'

export { PostgresSessionStore } from './store.ts'
export type { SqlExecutor } from './executor.ts'

/** Plugin configuration. */
export interface Config {
  /** PostgreSQL connection URI for the shared instance hosting every tenant schema. */
  connectionString: string
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/** PostgreSQL `SessionPersistence` provider with a tenant-schema physical codec. */
export class PostgresSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-postgres'

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    connectionString: z.string().required(),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  private readonly store: PostgresSessionStore
  private readonly coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.store = new PostgresSessionStore(
      createPgExecutor(new Pool({ connectionString: config.connectionString })),
    )
    this.coordinator = new PersistenceCoordinator(ctx, this.store, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  /** PostgreSQL stores sessions in one database, not one artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  delete(id: SessionId): Promise<void> {
    return this.coordinator.delete(id)
  }

  isDeleted(id: SessionId): boolean {
    return this.coordinator.isDeleted(id)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.store.list(signal)
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.store.listSnapshots(signal)
  }
}

/** Wrap one client's query surface (no nested transactions). */
function clientExecutor(client: PoolClient): SqlExecutor {
  return {
    query: async (text, values) => {
      const result = values === undefined ? await client.query(text) : await client.query(text, [...values])
      return result.rows as readonly Record<string, unknown>[]
    },
    transaction: () => {
      throw new Error('nested transactions are not supported by the pg adapter')
    },
    close: async () => {},
  }
}

/**
 * Adapt a `pg` pool to the {@link SqlExecutor} seam. `transaction` checks out
 * a client and commits on resolution or rolls back on rejection.
 * @param pool - the live `pg.Pool`.
 * @returns the executor wrapping the pool.
 */
export function createPgExecutor(pool: Pool): SqlExecutor {
  return {
    query: async (text, values) => {
      const result = values === undefined ? await pool.query(text) : await pool.query(text, [...values])
      return result.rows as readonly Record<string, unknown>[]
    },
    transaction: async (fn) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn(clientExecutor(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          // Swallow: the transaction is already doomed; the original `error`
          // is the signal worth surfacing, not a failed rollback of it.
        })
        throw error
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}

export default PostgresSessionPersistence
