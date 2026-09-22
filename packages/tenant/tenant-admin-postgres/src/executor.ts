/**
 * Query seam for the tenant-administration Postgres provider. Kept local like
 * the other tenant PG backends: each provider owns its executor of the surface
 * it needs (here: plain queries plus teardown — the record store's writes are
 * single statements and never need a transaction).
 * @module @deepseek-ai/dsh-tenant-admin-postgres/src/executor
 */

import type { Pool } from 'pg'

/** Parameterized-query surface backed by the `pg` driver. */
export interface SqlExecutor {
  /**
   * Run one parameterized statement and return its result rows.
   * @param text - the SQL statement (identifiers interpolated by the provider, values bound).
   * @param values - the bound parameters, if any.
   */
  query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>
  /** Close the underlying pool. */
  close(): Promise<void>
}

/**
 * Adapt a `pg` pool to the {@link SqlExecutor} seam.
 * @param pool - the live `pg.Pool`.
 * @returns the executor wrapping the pool.
 */
export function createPgExecutor(pool: Pool): SqlExecutor {
  return {
    query: async (text, values) => {
      const result = values === undefined ? await pool.query(text) : await pool.query(text, [...values])
      return result.rows as readonly Record<string, unknown>[]
    },
    close: () => pool.end(),
  }
}
