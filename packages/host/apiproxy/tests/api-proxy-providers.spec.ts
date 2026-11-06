/**
 * Managed provider routes over the tenant registry: the write methods store a
 * route and report it with its credential redacted, the listing says where each
 * route is defined, and a deployment without a registry refuses writes instead
 * of pretending to store them.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LlmRuntime, { LlmAdapter, LlmProviderStore } from '@deepseek-ai/dsh-llm'
import type { LlmProviderRecord } from '@deepseek-ai/dsh-llm'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

let nextRpc = 1
/** One wire request carrying the given payload. */
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('req-' + String(nextRpc++)), payload }
}

/** Unwrap an ok reply, failing the test on an error reply. */
function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

/** Unwrap an error reply, failing the test on an ok reply. */
function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** In-memory tenant registry: the medium is not what these methods are about. */
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
    if (!this.records.some(entry => entry.id === id)) throw new TypeError('no such record: ' + id)
    this.records = this.records.filter(entry => entry.id !== id)
    this.notifyChanged()
  }
}

/** A route this deployment registers but never streams through. */
class StubAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

/** Boot the proxy over a runtime and, optionally, a tenant registry. */
async function boot(options?: { registry?: boolean; route?: boolean }): Promise<{ ctx: Context; api: ReturnType<typeof createApiProxy> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerConfigurableProviders([
    { provider: 'catalog-route', displayName: 'Catalog Route', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'catalog-route'] },
  ])
  ctx.provide('workspaceRegistry', { list: () => [], ensureLoaded: async () => {} } as never)
  if (options?.route !== false) ctx.llm.registerAdapter(['acme-gateway'], new StubAdapter())
  if (options?.registry !== false) await ctx.plugin(MemoryProviderStore)
  return { ctx, api: createApiProxy(ctx, DEFAULTS) }
}

/** The whole record an administrator submits. */
const WRITE = {
  provider: 'acme-gateway',
  displayName: 'Acme Gateway',
  api: 'openai-completions',
  baseURL: 'https://gateway.acme.example/v1',
  apiKey: 'sk-acme-secret',
  models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 128000, maxTokens: 8192 }],
}

describe('managed provider routes', () => {
  it('stores a route and reports it with the credential redacted', async () => {
    const { ctx, api } = await boot()
    const value = expectOk(await api.llm.addProvider(request(WRITE)))
    expect(value.provider).toMatchObject({
      provider: 'acme-gateway',
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.acme.example/v1',
      enabled: true,
      apiKeyConfigured: true,
    })
    expect(value.provider.models).toEqual([{ id: 'acme-large', name: 'Acme Large', contextWindow: 128000, maxTokens: 8192 }])
    // The key is write-only: no reply may carry it back.
    expect(JSON.stringify(value)).not.toContain('sk-acme-secret')
    expect(ctx.llmProviders.snapshot()).toHaveLength(1)
  })

  it('lists a stored route as registry-sourced and a configured route as config-sourced', async () => {
    const { api } = await boot()
    expectOk(await api.llm.addProvider(request(WRITE)))
    const value = expectOk(await api.llm.providers(request({})))
    expect(value.providers.find(entry => entry.provider === 'acme-gateway')).toMatchObject({
      active: true,
      source: 'registry',
      apiKeyConfigured: true,
    })
    expect(value.providers.find(entry => entry.provider === 'catalog-route')).toMatchObject({ source: 'config' })
  })

  it('updates only the fields it is given and clears the key when told to', async () => {
    const { ctx, api } = await boot()
    expectOk(await api.llm.addProvider(request(WRITE)))
    const renamed = expectOk(await api.llm.updateProvider(request({ provider: 'acme-gateway', displayName: 'Acme EU' })))
    expect(renamed.provider).toMatchObject({ displayName: 'Acme EU', baseURL: 'https://gateway.acme.example/v1', apiKeyConfigured: true })
    const cleared = expectOk(await api.llm.updateProvider(request({ provider: 'acme-gateway', apiKey: null })))
    expect(cleared.provider.apiKeyConfigured).toBe(false)
    expect(ctx.llmProviders.snapshot()[0]?.apiKey).toBeUndefined()
  })

  it('deletes a stored route', async () => {
    const { ctx, api } = await boot()
    expectOk(await api.llm.addProvider(request(WRITE)))
    expectOk(await api.llm.removeProvider(request({ provider: 'acme-gateway' })))
    expect(ctx.llmProviders.snapshot()).toEqual([])
  })

  it('refuses an unusable record without storing it', async () => {
    const { ctx, api } = await boot()
    const error = expectErr(await api.llm.addProvider(request({ ...WRITE, baseURL: '' })))
    expect(error.code).toBe('provider-record-invalid')
    expect(ctx.llmProviders.snapshot()).toEqual([])
  })

  it('refuses an update of a route the registry does not hold', async () => {
    const { api } = await boot()
    const error = expectErr(await api.llm.updateProvider(request({ provider: 'acme-gateway', displayName: 'Acme EU' })))
    expect(error.code).toBe('provider-not-found')
  })

  it('refuses every write when the deployment mounts no registry', async () => {
    const { api } = await boot({ registry: false })
    for (const response of [
      await api.llm.addProvider(request(WRITE)),
      await api.llm.updateProvider(request({ provider: 'acme-gateway', displayName: 'Acme EU' })),
      await api.llm.removeProvider(request({ provider: 'acme-gateway' })),
    ]) {
      expect(expectErr(response).code).toBe('provider-registry-unavailable')
    }
  })
})
