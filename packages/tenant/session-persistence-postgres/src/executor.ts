/**
 * Executor seam for the tenant-keyed Postgres session store: run one
 * parameterized statement, run a multi-statement transaction, and release the
 * pool. Abstracted so the store is unit-tested without a live server;
 * production supplies a `pg` pool adapter.
 * @module @deepseek-ai/dsh-session-persistence-postgres/src/executor
 */

/** One queryable, transactional Postgres surface (production: a `pg.Pool`). */
export interface SqlExecutor {
  /**
   * Run one parameterized statement.
   * @param text - the SQL text.
   * @param values - positional parameters in order.
   * @returns the result rows, each column present as a `Record` member.
   */
  query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>

  /**
   * Run a sequence of statements atomically: commit on resolution, roll back
   * on rejection.
   * @param fn - the transactional work, run against a transaction-scoped executor.
   * @returns the work's result after commit.
   */
  transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>

  /**
   * Release the underlying pool. Idempotent; concurrent and repeated calls
   * resolve once teardown finishes.
   */
  close(): Promise<void>
}
