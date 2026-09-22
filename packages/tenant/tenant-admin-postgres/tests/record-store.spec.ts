import { describe, expect, it } from 'vitest'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantId } from '@deepseek-ai/dsh-tenant'
import { PostgresTenantRecordStore } from '../src/record-store.ts'
import type { SqlExecutor } from '../src/executor.ts'

/** Record the query surface and answer a canned `load` result-set. */
function fakeExecutor(rows: readonly Record<string, unknown>[] = []) {
  const calls: { text: string; values: readonly unknown[] | undefined }[] = []
  const executor: SqlExecutor = {
    query: async (text, values) => {
      calls.push({ text, values })
      return rows
    },
    close: async () => {},
  }
  return { executor, calls }
}

describe('PostgresTenantRecordStore', () => {
  it('loads rows back into branded records, normalizing the nullable columns', async () => {
    const { executor } = fakeExecutor([{
      id: 'acme',
      name: 'Acme',
      data_root: '/data/acme',
      workspace_root: '/ws/acme',
      tools_root: null,
      enabled: false,
      network: 'internal',
      members: ['user-1', 'user-2'],
    }])
    const store = new PostgresTenantRecordStore(executor)

    await expect(store.load()).resolves.toEqual([{
      id: TenantId('acme'),
      name: 'Acme',
      dataRoot: '/data/acme',
      workspaceRoot: '/ws/acme',
      enabled: false,
      network: 'internal',
      members: ['user-1', 'user-2'],
    }])
  })

  it('round-trips a fully-optional record, binding absent fields as null', async () => {
    const { executor, calls } = fakeExecutor()
    const store = new PostgresTenantRecordStore(executor)
    const tenant: Tenant = {
      id: TenantId('beta'),
      name: 'Beta',
      dataRoot: '/data/beta',
      workspaceRoot: '/ws/beta',
    }

    await store.upsert(tenant)

    expect(calls[0]?.values).toEqual([
      'beta', 'Beta', '/data/beta', '/ws/beta', null, true, null, null,
    ])
  })

  it('binds provided members, toolsRoot, network, and disabled state', async () => {
    const { executor, calls } = fakeExecutor()
    const store = new PostgresTenantRecordStore(executor)
    const tenant: Tenant = {
      id: TenantId('acme'),
      name: 'Acme',
      dataRoot: '/data/acme',
      workspaceRoot: '/ws/acme',
      toolsRoot: '/tools',
      enabled: false,
      network: 'none',
      members: ['user-1'],
    }

    await store.upsert(tenant)

    expect(calls[0]?.values).toEqual([
      'acme', 'Acme', '/data/acme', '/ws/acme', '/tools', false, 'none', '["user-1"]',
    ])
  })

  it('deletes by id', async () => {
    const { executor, calls } = fakeExecutor()
    const store = new PostgresTenantRecordStore(executor)

    await store.delete(TenantId('acme'))

    expect(calls[0]?.values).toEqual(['acme'])
  })
})
