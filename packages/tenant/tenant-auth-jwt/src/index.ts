/**
 * JWT/OIDC authentication provider (`ctx.tenantAuth`). Verifies RS256 tokens
 * against an OIDC JWKS endpoint, or HS256 tokens against a shared secret, and
 * returns the tenant principal proved by the verified claims. Algorithm is
 * pinned per verification mode so a token cannot be accepted under a weaker
 * scheme.
 *
 * @module @deepseek-ai/dsh-tenant-auth-jwt
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { JWTPayload, JWTVerifyOptions } from 'jose'
import { TenantId } from '@deepseek-ai/dsh-tenant'
import { TenantAuthenticator, TenantAuthError } from '@deepseek-ai/dsh-tenant-auth'
import type { TenantPrincipal } from '@deepseek-ai/dsh-tenant-auth'

/** Default clock-skew tolerance applied to `exp`/`nbf`, in seconds. */
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30

/** Plugin configuration. Exactly one verification mode must be configured. */
export interface Config {
  /** Expected issuer (`iss`) of accepted tokens. */
  issuer: string
  /** Expected audience (`aud`); when set, tokens must match. */
  audience?: string
  /** OIDC JWKS URI for RS256 verification; mutually exclusive with `secret`. */
  jwksUri?: string
  /** Shared HMAC secret for HS256 verification; mutually exclusive with `jwksUri`. */
  secret?: string
  /** Claim holding the tenant id. */
  tenantIdClaim?: string
  /** Clock-skew tolerance in seconds for `exp`/`nbf`. */
  clockToleranceSeconds?: number
}

type VerifyMode = 'jwks' | 'secret'

/**
 * {@link TenantAuthenticator} provider that verifies a bearer JWT and returns
 * the tenant principal from its verified claims.
 */
export class JwtTenantAuthenticator extends TenantAuthenticator {
  static Config: z<Config> = z.object({
    issuer: z.string().required(),
    audience: z.string(),
    jwksUri: z.string(),
    secret: z.string(),
    tenantIdClaim: z.string().default('tenantId'),
    clockToleranceSeconds: z.number().step(1).min(0).default(DEFAULT_CLOCK_TOLERANCE_SECONDS),
  })

  private readonly mode: VerifyMode
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | undefined
  private readonly secretKey: Uint8Array | undefined
  private readonly tenantIdClaim: string
  private readonly clockTolerance: number

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    const hasJwks = config.jwksUri !== undefined && config.jwksUri !== ''
    const hasSecret = config.secret !== undefined && config.secret !== ''
    if (hasJwks === hasSecret) {
      throw new Error(
        '@deepseek-ai/dsh-tenant-auth-jwt requires exactly one of "jwksUri" or "secret"',
      )
    }
    this.mode = hasJwks ? 'jwks' : 'secret'
    this.jwks = config.jwksUri !== undefined && config.jwksUri !== ''
      ? createRemoteJWKSet(new URL(config.jwksUri))
      : undefined
    this.secretKey = hasSecret ? new TextEncoder().encode(config.secret) : undefined
    this.tenantIdClaim = config.tenantIdClaim ?? 'tenantId'
    this.clockTolerance = config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS
  }

  async authenticate(credential: string): Promise<TenantPrincipal> {
    const token = this.stripBearer(credential)
    if (token === undefined) {
      throw new TenantAuthError('MISSING_CREDENTIAL', 'no bearer credential was supplied')
    }
    return this.principalOf(await this.verifyOrThrow(token))
  }

  private stripBearer(credential: string): string | undefined {
    const trimmed = credential.trim()
    if (trimmed === '') return undefined
    const prefix = trimmed.startsWith('Bearer ')
      ? 'Bearer '
      : trimmed.startsWith('bearer ')
        ? 'bearer '
        : ''
    return prefix === '' ? trimmed : (trimmed.slice(prefix.length).trim() || undefined)
  }

  private verifyOptions(): JWTVerifyOptions {
    const options: JWTVerifyOptions = {
      issuer: this.config.issuer,
      clockTolerance: this.clockTolerance,
      algorithms: this.mode === 'jwks' ? ['RS256'] : ['HS256'],
    }
    if (this.config.audience !== undefined) {
      options.audience = this.config.audience
    }
    return options
  }

  private async verifyOrThrow(token: string): Promise<JWTPayload> {
    try {
      const options = this.verifyOptions()
      if (this.mode === 'jwks' && this.jwks !== undefined) {
        return (await jwtVerify(token, this.jwks, options)).payload
      }
      if (this.secretKey !== undefined) {
        return (await jwtVerify(token, this.secretKey, options)).payload
      }
    } catch {
      // jwtVerify rejects on signature, algorithm, and registered-claim
      // (iss/aud/exp/nbf) mismatches only; verification keys and claims come
      // from construction-time config. Every such failure means "unverifiable",
      // never "accept this token under a weaker check".
      throw new TenantAuthError('INVALID_TOKEN', 'token signature or claims could not be verified')
    }
    throw new TenantAuthError('INVALID_TOKEN', 'no verification key was configured for this authenticator')
  }

  private principalOf(payload: JWTPayload): TenantPrincipal {
    const rawTenant = payload[this.tenantIdClaim]
    if (typeof rawTenant !== 'string' || rawTenant === '') {
      throw new TenantAuthError('INVALID_TOKEN', `missing tenant id claim '${this.tenantIdClaim}'`)
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new TenantAuthError('INVALID_TOKEN', 'missing subject claim')
    }
    const scopes = this.scopesOf(payload)
    return scopes === undefined
      ? { tenantId: TenantId(rawTenant), subject: payload.sub }
      : { tenantId: TenantId(rawTenant), subject: payload.sub, scopes }
  }

  private scopesOf(payload: JWTPayload): readonly string[] | undefined {
    const scope = payload.scope
    if (typeof scope !== 'string' || scope === '') return undefined
    return scope.split(/\s+/u)
  }
}

export default JwtTenantAuthenticator
