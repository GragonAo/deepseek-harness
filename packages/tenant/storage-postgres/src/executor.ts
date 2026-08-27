/**
 * Executor seam for the tenant-keyed Postgres backends: run one parameterized
 * statement and read its rows, and release the connection pool. Abstracted so
 * the SQL layer is unit-tested without a live server; production supplies a
 * `pg` pool adapter.
 * @module @deepseek-ai/dsh-storage-postgres/src/executor
 */

/** One queryable Postgres surface (production: a `pg.Pool` adapter). */
export interface SqlExecutor {
  /**
   * Run one parameterized statement.
   * @param text - the SQL text.
   * @param values - positional parameters in order.
   * @returns the result rows, each column present as a `Record` member.
   */
  query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>

  /**
   * Release the underlying pool. Idempotent; concurrent and repeated calls
   * resolve once teardown finishes.
   */
  close(): Promise<void>
}
