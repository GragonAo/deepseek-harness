import { describe, expect, it } from 'vitest'
import { TenantId } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { makeDemoOperation } from '../src/operation.ts'
import type { DemoDeps } from '../src/operation.ts'

function tenant(id: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot: `/workspace/${id}` }
}

describe('makeDemoOperation', () => {
  it('runs a container tool call, reads it back, and persists a session event', async () => {
    const created: unknown[] = []
    const appended: unknown[] = []
    const deps = {
      sessionPersistence: {
        create: async (meta: unknown) => { created.push(meta) },
        append: async (id: unknown, events: unknown) => { appended.push({ id, events }) },
      },
      subprocess: {
        spawn: (_spec: { argv: readonly string[] }) => ({
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
        }),
      },
      fs: {
        resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
        readText: async (_target: unknown) => 'acme\n',
      },
    }
    const operation = makeDemoOperation(deps as unknown as DemoDeps)
    const result = await operation({
      tenant: tenant('acme'),
      principal: { tenantId: TenantId('acme'), subject: 'demo-user' },
      body: {},
    }) as { tenantId: string; marker: string; sessionId: string }
    expect(result.tenantId).toBe('acme')
    expect(result.marker).toBe('acme')
    expect(result.sessionId).toMatch(/^demo-acme-/)
    expect(created).toHaveLength(1)
    expect(appended).toHaveLength(1)
    const events = (appended[0] as { events: Array<{ type: string }> }).events
    expect(events[0]?.type).toBe('todo/write')
  })
})
