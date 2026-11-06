// The tenant provider registry as the routing consumer sees it: a stored record
// overrides a same-named configuration route, adds routes of its own, and armed
// with its own credential — while removing the record falls back to the
// configuration tiers. Every change re-registers the route set in-process.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmProviderStore } from '@deepseek-ai/dsh-llm'
import type { LlmProviderRecord } from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

/** In-memory tenant registry: the medium does not matter to the consumer. */
class MemoryProviderStore extends LlmProviderStore {
  private records: readonly LlmProviderRecord[] = []

  override get writable(): boolean {
    return true
  }

  override snapshot(): readonly LlmProviderRecord[] {
    return this.records
  }

  override async refresh(): Promise<readonly LlmProviderRecord[]> {
    return this.records
  }

  override async list(): Promise<readonly LlmProviderRecord[]> {
    return this.records
  }

  override async upsert(record: LlmProviderRecord): Promise<void> {
    this.records = [...this.records.filter(entry => entry.id !== record.id), record]
    this.notifyChanged()
  }

  override async remove(id: string): Promise<void> {
    this.records = this.records.filter(entry => entry.id !== id)
    this.notifyChanged()
  }
}

/** One record an administrator would store for the tenant. */
function record(overrides: Partial<LlmProviderRecord> = {}): LlmProviderRecord {
  return {
    id: 'acme-gateway',
    displayName: 'Acme Gateway',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'registry-model' }],
    enabled: true,
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  }
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
})

/** Boot the runtime with a file settings tier, credentials, and the registry. */
async function boot(config: LlmPiAi.Config): Promise<{ ctx: Context; store: MemoryProviderStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-registry-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.yaml'), '# empty\n')
  await writeFile(join(dir, '.credentials.yaml'), 'REGISTRY_CONFIG_KEY: from-credentials\n', { mode: 0o600 })
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(MemoryProviderStore)
  await ctx.plugin(LlmPiAi, config)
  return { ctx, store: ctx.llmProviders as MemoryProviderStore }
}

/** The configuration-tier route the registry can override. */
const CONFIG: LlmPiAi.Config = {
  providers: {
    'acme-gateway': {
      apiKeyEnv: 'REGISTRY_CONFIG_KEY',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:8/v1',
      models: [{ id: 'config-model' }],
    },
  },
}

describe('tenant provider registry', () => {
  it('serves the configuration-tier route when the registry holds nothing', async () => {
    const { ctx } = await boot(CONFIG)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['acme-gateway'])
    expect((await ctx.llm.listModels('acme-gateway')).map(model => model.id)).toEqual(['config-model'])
  })

  it('overrides a same-named configuration route with the stored record', async () => {
    const { ctx, store } = await boot(CONFIG)
    await store.upsert(record())
    expect((await ctx.llm.listModels('acme-gateway')).map(model => model.id)).toEqual(['registry-model'])
  })

  it('registers a stored route the configuration never mentions', async () => {
    const { ctx, store } = await boot({})
    expect(ctx.llm.listProviders()).toEqual([])
    await store.upsert(record({ id: 'tenant-only', displayName: 'Tenant Only' }))
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['tenant-only'])
    expect((await ctx.llm.listModels('tenant-only')).map(model => model.id)).toEqual(['registry-model'])
  })

  it('falls back to the configuration route once the record is removed', async () => {
    const { ctx, store } = await boot(CONFIG)
    await store.upsert(record())
    expect((await ctx.llm.listModels('acme-gateway')).map(model => model.id)).toEqual(['registry-model'])
    await store.remove('acme-gateway')
    expect((await ctx.llm.listModels('acme-gateway')).map(model => model.id)).toEqual(['config-model'])
  })

  it('authenticates a request with the stored credential', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx, store } = await boot({})
    await store.upsert(record({ baseURL: server.url + '/v1', apiKey: 'sk-from-registry' }))
    const result = await assemble(ctx, { provider: 'acme-gateway', model: 'registry-model', messages: [] })
    expect(result.finish.kind).toBe('stop')
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer sk-from-registry')
  })
})
