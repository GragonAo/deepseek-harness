import { Context } from '@deepseek-ai/cordis'
import { currentRequestHeaders, runWithRequestHeaders } from '@deepseek-ai/dsh-tenant'
import { describe, expect, it } from 'vitest'
import { TenantMcpCallMeta } from '../src/mcp-meta.ts'

describe('request header scope', () => {
  it('answers the entered headers and nothing outside a run', () => {
    expect(currentRequestHeaders()).toBeUndefined()

    const seen = runWithRequestHeaders({ 'x-user': 'u-1' }, () => currentRequestHeaders())
    expect(seen).toEqual({ 'x-user': 'u-1' })
    expect(currentRequestHeaders()).toBeUndefined()
  })

  it('shadows an outer run and restores it on unwind', () => {
    runWithRequestHeaders({ 'x-user': 'outer' }, () => {
      expect(currentRequestHeaders()).toEqual({ 'x-user': 'outer' })
      runWithRequestHeaders({ 'x-user': 'inner' }, () => {
        expect(currentRequestHeaders()).toEqual({ 'x-user': 'inner' })
      })
      expect(currentRequestHeaders()).toEqual({ 'x-user': 'outer' })
    })
  })

  it('survives an await inside the tree', async () => {
    await runWithRequestHeaders({ 'x-case': 'case-1' }, async () => {
      await Promise.resolve()
      expect(currentRequestHeaders()).toEqual({ 'x-case': 'case-1' })
    })
  })
})

describe('TenantMcpCallMeta', () => {
  const mount = (config: ConstructorParameters<typeof TenantMcpCallMeta>[1]) => {
    const ctx = new Context()
    return { ctx, meta: new TenantMcpCallMeta(ctx, config) }
  }

  it('maps the configured header names onto _meta keys', () => {
    const { meta } = mount({ fromHeaders: { user_id: 'X-User', case_id: 'x-case' } })
    const entries = runWithRequestHeaders(
      { 'x-user': 'u-1', 'x-case': 'case-1', 'x-ignored': 'nope' },
      () => meta.entries(),
    )
    // Header names match case-insensitively; headers outside the mapping do not leak.
    expect(entries).toEqual({ user_id: 'u-1', case_id: 'case-1' })
  })

  it('omits a mapped header the request did not carry', () => {
    const { meta } = mount({ fromHeaders: { user_id: 'x-user', case_id: 'x-case' } })
    expect(runWithRequestHeaders({ 'x-user': 'u-1' }, () => meta.entries())).toEqual({ user_id: 'u-1' })
  })

  it('sends nothing without an ambient request or without a resolvable entry', () => {
    const { meta } = mount({ fromHeaders: { user_id: 'x-user' } })
    expect(meta.entries()).toBeUndefined()
    expect(runWithRequestHeaders({ 'x-other': 'v' }, () => meta.entries())).toBeUndefined()
  })

  it('sends nothing when the deployment configured no mapping', () => {
    const { meta } = mount({})
    expect(runWithRequestHeaders({ 'x-user': 'u-1' }, () => meta.entries())).toBeUndefined()
  })
})
