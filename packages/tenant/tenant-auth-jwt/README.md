# @deepseek-ai/dsh-tenant-auth-jwt

English | [中文](README.zh.md)

JWT/OIDC provider for the [`dsh-tenant-auth`](../tenant-auth) seam. It verifies the bearer token and returns the [`TenantPrincipal`](../tenant-auth) proved by its verified claims: `tenantId` from a configurable claim, `subject` from the standard `sub`, and optional scopes from the `scope` claim.

## Configuration

```yaml
- id: tenant-auth
  name: '@deepseek-ai/dsh-tenant-auth-jwt'
  config:
    issuer: 'https://keycloak.example/realms/enterprise'
    audience: 'dsh-api'          # optional; when set, tokens must match
    jwksUri: 'https://keycloak.example/realms/enterprise/protocol/openid-connect/certs'
    tenantIdClaim: 'tenantId'    # default
```

Exactly one of `jwksUri` (RS256 via JWKS) or `secret` (HS256 shared secret, for local/dev tokens) must be set; supplying both or neither fails loud at load. `clockToleranceSeconds` defaults to `30`.

The algorithm is pinned per mode: HS256 for `secret`, RS256 for `jwksUri` — a token is never accepted under a weaker scheme.

## Model Experience

### Token verification and tenant principal

#### What the model sees

Nothing. Verification runs in the `ctx.tenantAuth` transport layer and never reaches the model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **Remote JWKS fetches are not abortable per call** — the `authenticate` contract carries no `AbortSignal`, so a stalled discovery fetch cannot be cancelled by the caller.
- **No role-to-tenant mapping** — the tenant id comes directly from one claim; deployments that derive tenants from roles or groups need an additional mapping provider.