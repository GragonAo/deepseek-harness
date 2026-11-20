// The durable boundary of an administrator-managed route: what
// assertProviderRecord keeps, and what it refuses before the record can reach
// the storage medium. A field it silently dropped would be a value the
// administrator set and the deployment never honoured.

import { describe, expect, it } from 'vitest'
import { assertProviderRecord } from '../src/provider-store.ts'

/** A full record an administrator could store, before overrides. */
function candidate(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'acme-gateway',
    displayName: 'Acme Gateway',
    api: 'openai-completions',
    baseURL: 'https://acme.test/v1',
    models: [{ id: 'acme-large' }],
    ...overrides,
  }
}

describe('assertProviderRecord', () => {
  it('keeps a model entry\'s declared modalities', () => {
    const record = assertProviderRecord(candidate({
      models: [{ id: 'acme-vision', inputModalities: ['text', 'image'] }],
    }))

    expect(record.models).toEqual([{ id: 'acme-vision', inputModalities: ['text', 'image'] }])
  })

  it('leaves the field off a model entry that declares nothing', () => {
    const record = assertProviderRecord(candidate())

    expect(record.models).toEqual([{ id: 'acme-large' }])
    expect('inputModalities' in record.models[0]!).toBe(false)
  })

  it('refuses a modality this build cannot serve', () => {
    expect(() => assertProviderRecord(candidate({
      models: [{ id: 'acme-large', inputModalities: ['text', 'audio'] }],
    }))).toThrow(/"text" and "image", not "audio"/)
  })

  it('refuses an empty modality list, whose undeclared spelling is omission', () => {
    expect(() => assertProviderRecord(candidate({
      models: [{ id: 'acme-large', inputModalities: [] }],
    }))).toThrow(/must be a non-empty array/)
  })

  it('refuses a modality list that is not a list', () => {
    expect(() => assertProviderRecord(candidate({
      models: [{ id: 'acme-large', inputModalities: 'text' }],
    }))).toThrow(/must be a non-empty array/)
  })
})
