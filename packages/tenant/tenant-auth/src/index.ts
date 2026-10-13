/**
 * Tenant-authentication Service Definition (`ctx.tenantAuth`).
 *
 * A provider verifies one credential and returns the {@link TenantPrincipal} it
 * proves. A tenant-scoped credential proves a `tenantId` and a `subject`; a
 * platform credential proves a `subject` and its scopes and names no tenant at
 * all, which is what lets the management surface admit it. The API layer
 * resolves the tenant record through `ctx.tenants` and enters `runWithTenant` —
 * authentication never mints authorization, and a request can only address the
 * tenant its credential proves.
 *
 * @module @deepseek-ai/dsh-tenant-auth
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { TenantId } from '@deepseek-ai/dsh-tenant'

/** The principal an authenticated credential proves. */
export interface TenantPrincipal {
  /**
   * The tenant the credential proves. Absent when the credential is
   * platform-scoped: a carrier that serves a tenant refuses such a principal,
   * while the management surface admits it on its scope alone.
   */
  readonly tenantId?: TenantId
  /** The authenticated subject (`sub`) the credential vouches for. */
  readonly subject: string
  /** Optional space-derived scopes, carried forward for authorization policies. */
  readonly scopes?: readonly string[]
}

/** Authentication failure codes. */
export type TenantAuthErrorCode = 'MISSING_CREDENTIAL' | 'INVALID_TOKEN'

/**
 * Structured error for credential verification failures.
 */
export class TenantAuthError extends Error {
  /** Machine-readable failure code (`MISSING_CREDENTIAL` or `INVALID_TOKEN`). */
  readonly code: TenantAuthErrorCode

  constructor(code: TenantAuthErrorCode, message: string) {
    super(message)
    this.name = 'TenantAuthError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenantAuth: TenantAuthenticator
  }
}

/**
 * Abstract tenant authenticator (`ctx.tenantAuth`). Subclass, implement
 * {@link authenticate}, and load the subclass as a plugin.
 */
export abstract class TenantAuthenticator extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tenantAuth')
  }

  /**
   * Verify a credential and return the principal it proves.
   * @param credential - the credential bytes, including any `Bearer ` scheme
   *   (providers strip or reject scheme prefixes they accept).
   * @returns the authenticated tenant principal.
   * @throws `TenantAuthError` code `MISSING_CREDENTIAL` when no credential is
   *   supplied, or `INVALID_TOKEN` when it cannot be verified or lacks the
   *   required claims.
   */
  abstract authenticate(credential: string): Promise<TenantPrincipal>
}

export default TenantAuthenticator
