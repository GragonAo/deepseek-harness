import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TenantId } from '@deepseek-ai/dsh-tenant'
import TenantAuthenticator, { TenantAuthError } from '../src/index.ts'

class FakeAuthenticator extends TenantAuthenticator {
  async authenticate(credential: string) {
    if (credential === '') {
      throw new TenantAuthError('MISSING_CREDENTIAL', 'empty credential')
    }
    return { tenantId: TenantId('acme'), subject: 'user-1', scopes: ['sessions:write'] }
  }
}

describe('TenantAuthenticator', () => {
  it('mounts as ctx.tenantAuth and authenticates a credential', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeAuthenticator)
    expect(ctx.tenantAuth).toBeInstanceOf(TenantAuthenticator)
    await expect(ctx.tenantAuth.authenticate('token')).resolves.toMatchObject({
      tenantId: 'acme',
      subject: 'user-1',
    })
  })

  it('propagates the provider error code', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeAuthenticator)
    await expect(ctx.tenantAuth.authenticate('')).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})
