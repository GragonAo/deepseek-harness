import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as SessionUploadsInvariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers the package under its manifest name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(SessionUploadsInvariant).await()).resolves.toBeDefined()
  })
})
