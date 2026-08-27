# @deepseek-ai/dsh-tenant-auth

English | [中文](README.zh.md)

Tenant-authentication Service Definition (`ctx.tenantAuth`) for multi-tenant DeepSeek Harness deployments.

## Shape

- `TenantPrincipal` — the result of a successful verification: `tenantId`, `subject`, and optional `scopes`.
- `TenantAuthError` — structured error with `code` `MISSING_CREDENTIAL` or `INVALID_TOKEN`.
- `TenantAuthenticator` (`ctx.tenantAuth`) — the abstract Service Definition. A provider subclasses it, implements `authenticate(credential)`, and loads as the service. The shipped provider is [`@deepseek-ai/dsh-tenant-auth-jwt`](../tenant-auth-jwt).

Authentication proves identity only: the provider returns the authenticated `tenantId`, and the API layer resolves the tenant record through `ctx.tenants` and enters `runWithTenant`. A request can only address the tenant its credential proves.

## Model Experience

### Credential verification

#### What the model sees

Nothing. `ctx.tenantAuth` serves the API transport layer only: it registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **No authorization policy** — the principal carries scopes but this seam enforces no access checks; authorization is the API layer's concern.
- **The contract has no cancellation signal** — `authenticate` cannot forward a request abort; the JWT provider's remote JWKS fetch is not abortable per call.