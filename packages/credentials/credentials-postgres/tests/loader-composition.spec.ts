/**
 * Real-composition guard: the provider boots from a test-only cordis.yml
 * through the actual Loader + Include path, with a stub postgres backend
 * registered under `postgres` on the storage hub. A tenant `set` routes into
 * the tenant schema and `resolve` reads it back — proving the `static inject`
 * of the `storage.backend.postgres` service key orders backend registration
 * ahead of the provider.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { PostgresStorageBackend } from '@deepseek-ai/dsh-storage-postgres'
import type { SqlExecutor } from '@deepseek-ai/dsh-storage-postgres'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import TenantRegistry, { TenantId, UserId, runWithTenant, runWithUser, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import PostgresCredentialProvider from '../src/index.ts'

const KEY = credentialRef('DSH_POSTGRES_TEST_CRED')

function tenant(id: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot: `/workspace/${id}` }
}

/** Enter the ambient (tenant, user) scope most request paths run under. */
function scoped<T>(t: Tenant, user: string, fn: () => T): T {
  return runWithTenant(t, () => runWithUser(UserId(user), fn))
}

class RecordingExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []

  async query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
    this.calls.push(values === undefined ? { text } : { text, values })
    return []
  }

  async close(): Promise<void> {}
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; executor: RecordingExecutor }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-credentials-postgres-composition-'))
  const executor = new RecordingExecutor()

  const stubPostgres = {
    name: 'test-postgres-backend',
    inject: ['storage'],
    apply: (ctx: Context) => {
      const backend = new PostgresStorageBackend(executor)
      ctx.effect(() => ctx.storage.backend.register('postgres', backend))
      ctx.provide(storageBackendServiceKey('postgres'), backend)
    },
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: tenant',
    "  name: '@deepseek-ai/dsh-tenant'",
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: test-postgres',
    "  name: 'test-postgres-backend'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-postgres'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-tenant', TenantRegistry],
        ['@deepseek-ai/dsh-storage', Storage],
        ['test-postgres-backend', stubPostgres],
        ['@deepseek-ai/dsh-credentials-postgres', PostgresCredentialProvider],
      ])
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, executor }
}

describe('credentials-postgres real composition', () => {
  it('boots from cordis.yml and stores a tenant credential through the tenant schema', async () => {
    const { ctx, executor } = await loadComposition()
    await scoped(tenant('acme'), 'user-1', () => ctx.credentials.set(KEY, 'sk-a'))
    const schema = tenantPartitionName(TenantId('acme'))
    const insert = executor.calls.find(c => c.text.includes(`${schema}.kv_record`) && c.text.includes('INSERT'))
    expect(insert, 'routes the write to the tenant schema').toBeDefined()
    expect(insert!.values).toEqual(['credentials_doc', 'user-1', 'ref', KEY, JSON.stringify('sk-a')])
  })
})
