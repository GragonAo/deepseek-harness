/**
 * PostgreSQL storage backend plugin: registers the tenant-keyed backend as
 * `postgres` on the storage hub.
 * @module @deepseek-ai/dsh-storage-postgres
 */

import type { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import z from '@deepseek-ai/schemastery'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from './backend.ts'
import type { SqlExecutor } from './executor.ts'

export { PostgresStorageBackend } from './backend.ts'
export type { SqlExecutor } from './executor.ts'

/** Cordis plugin name. */
export const name = 'storage-postgres'
/** The backend registers on the storage hub. */
export const inject = ['storage']

/** Plugin configuration. */
export interface Config {
  /**
   * PostgreSQL connection URI. The role must hold CREATE on the target
   * database: each tenant's first write creates its own schema.
   */
  connectionString: string
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  connectionString: z.string().required(),
})

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

/**
 * Register the tenant-keyed backend as `postgres` on the storage hub. The
 * disposer unregisters first, then closes the pool.
 * @param ctx - Plugin context (must inject `storage`).
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  const pool = new Pool({ connectionString: config.connectionString })
  const backend = new PostgresStorageBackend(createPgExecutor(pool))
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('postgres', backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'storage-postgres.registerBackend')
  ctx.provide(storageBackendServiceKey('postgres'), backend)
}
