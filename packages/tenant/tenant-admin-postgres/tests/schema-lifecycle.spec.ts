import { describe, expect, it } from 'vitest'
import { TenantId, tenantPartitionName } from '@deepseek-ai/dsh-tenant'
import { PostgresTenantSchemaLifecycle } from '../src/schema-lifecycle.ts'
import type { SqlExecutor } from '../src/executor.ts'

/** Record one call's statement and bound values. */
function fakeExecutor() {
  const calls: { text: string; values: readonly unknown[] | undefined }[] = []
  const executor: SqlExecutor = {
    query: async (text, values) => {
      calls.push({ text, values })
      return []
    },
    close: async () => {},
  }
  return { executor, calls }
}

describe('PostgresTenantSchemaLifecycle', () => {
  it('provisions the tenant partition schema idempotently', async () => {
    const { executor, calls } = fakeExecutor()
    const lifecycle = new PostgresTenantSchemaLifecycle(executor)

    await lifecycle.provision(TenantId('acme'))

    expect(calls[0]?.text).toBe(`CREATE SCHEMA IF NOT EXISTS ${tenantPartitionName(TenantId('acme'))}`)
  })

  it('purges the tenant partition schema cascading', async () => {
    const { executor, calls } = fakeExecutor()
    const lifecycle = new PostgresTenantSchemaLifecycle(executor)

    await lifecycle.purge(TenantId('beta'))

    expect(calls[0]?.text).toBe(`DROP SCHEMA IF EXISTS ${tenantPartitionName(TenantId('beta'))} CASCADE`)
  })
})
