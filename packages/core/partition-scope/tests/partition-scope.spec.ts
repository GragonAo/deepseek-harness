import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { currentPartition, isPartitionlessFailure, type PartitionScope, type RequestPartition } from '../src/index.ts'

/** Fixed ambient partition service so a test can pin one partition without a carrier. */
class FixedPartition extends Service implements PartitionScope {
  constructor(ctx: Context, private readonly fixed: RequestPartition | undefined) {
    super(ctx, 'partitionScope')
  }

  current(): RequestPartition | undefined {
    return this.fixed
  }
}

const PARTITION: RequestPartition = {
  tenant: 'acme',
  user: 'sub-1',
  tenantName: 'tenant_acme_0f1e2d3c4b5a',
  userName: 'user_sub_1_9a8b7c6d5e4f',
  dataRoot: '/data/acme/sub-1',
}

describe('currentPartition', () => {
  it('resolves the mounted provider\'s ambient partition', () => {
    const ctx = new Context()
    new FixedPartition(ctx, PARTITION)

    expect(currentPartition(ctx)).toEqual(PARTITION)
  })

  it('resolves undefined in a single-partition deployment', () => {
    expect(currentPartition(new Context())).toBeUndefined()
  })

  it('resolves undefined for a mounted provider with no ambient partition', () => {
    const ctx = new Context()
    new FixedPartition(ctx, undefined)

    expect(currentPartition(ctx)).toBeUndefined()
  })
})

describe('isPartitionlessFailure', () => {
  it('recognizes a partition-scoped backend\'s partitionless rejection', () => {
    expect(isPartitionlessFailure(Object.assign(new Error('no tenant in scope'), { code: 'NO_TENANT_IN_SCOPE' }))).toBe(true)
  })

  it('rejects another failure code', () => {
    expect(isPartitionlessFailure(Object.assign(new Error('unknown tenant'), { code: 'TENANT_UNKNOWN' }))).toBe(false)
  })

  it('rejects a matching code on a value that is not an error', () => {
    expect(isPartitionlessFailure({ code: 'NO_TENANT_IN_SCOPE' })).toBe(false)
  })

  it('rejects a failure carrying no code', () => {
    expect(isPartitionlessFailure(new Error('storage fault'))).toBe(false)
  })
})
