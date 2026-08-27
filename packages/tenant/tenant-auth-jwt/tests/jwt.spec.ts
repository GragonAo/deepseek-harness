import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SignJWT } from 'jose'
import JwtTenantAuthenticator from '../src/index.ts'
import type { Config } from '../src/index.ts'

const ISSUER = 'https://issuer.example'
const SECRET = 'dev-secret-that-is-long-enough-for-hs256-signing'
const key = new TextEncoder().encode(SECRET)

interface MintOptions {
  issuer?: string
  audience?: string
  subject?: string
  expiresAtSeconds?: number
}

function mint(payload: Record<string, unknown>, options: MintOptions = {}): Promise<string> {
  let builder = new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuer(options.issuer ?? ISSUER)
  builder = builder.setSubject(options.subject ?? 'user-1')
  if (options.audience !== undefined) builder = builder.setAudience(options.audience)
  builder = builder.setExpirationTime(options.expiresAtSeconds ?? Math.floor(Date.now() / 1000) + 3600)
  return builder.sign(key)
}

async function mount(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: SECRET, ...overrides })
  return ctx.tenantAuth
}

describe('JwtTenantAuthenticator', () => {
  it('returns the principal proved by a valid token, stripping the Bearer scheme', async () => {
    const auth = await mount()
    const token = await mint({ tenantId: 'acme', scope: 'sessions:write prompts:read' })
    await expect(auth.authenticate(`Bearer ${token}`)).resolves.toMatchObject({
      tenantId: 'acme',
      subject: 'user-1',
      scopes: ['sessions:write', 'prompts:read'],
    })
  })

  it('fails closed on a missing credential', async () => {
    const auth = await mount()
    await expect(auth.authenticate('   ')).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('rejects a token signed with a different secret', async () => {
    const auth = await mount()
    const forged = await mint({ tenantId: 'acme' }, {})
      .then(() => new SignJWT({ tenantId: 'acme' }).setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER).setSubject('user-1').setExpirationTime('1h')
        .sign(new TextEncoder().encode('a-different-secret-value')))
    await expect(auth.authenticate(forged)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('rejects an expired token', async () => {
    const auth = await mount()
    const token = await mint({ tenantId: 'acme' }, { expiresAtSeconds: Math.floor(Date.now() / 1000) - 60 })
    await expect(auth.authenticate(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('rejects a token from the wrong issuer', async () => {
    const auth = await mount()
    const token = await mint({ tenantId: 'acme' }, { issuer: 'https://evil.example' })
    await expect(auth.authenticate(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('enforces the audience when configured', async () => {
    const auth = await mount({ audience: 'dsh-api' })
    const wrong = await mint({ tenantId: 'acme' }, { audience: 'other-app' })
    await expect(auth.authenticate(wrong)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    const right = await mint({ tenantId: 'acme' }, { audience: 'dsh-api' })
    await expect(auth.authenticate(right)).resolves.toMatchObject({ tenantId: 'acme' })
  })

  it('rejects a token missing the tenant id claim', async () => {
    const auth = await mount()
    const token = await mint({})
    await expect(auth.authenticate(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
  })

  it('honors a custom tenant id claim name', async () => {
    const auth = await mount({ tenantIdClaim: 'org' })
    const token = await mint({ org: 'acme' })
    await expect(auth.authenticate(token)).resolves.toMatchObject({ tenantId: 'acme' })
  })

  it('fails loud when neither or both verification modes are configured', () => {
    expect(() => new JwtTenantAuthenticator(new Context(), { issuer: ISSUER })).toThrow()
    expect(() => new JwtTenantAuthenticator(new Context(), {
      issuer: ISSUER,
      secret: SECRET,
      jwksUri: 'https://issuer.example/.well-known/jwks.json',
    })).toThrow()
  })
})
