# tenant/ — multi-tenant isolation

English | [中文](README.zh.md)

Multi-tenant isolation layered on the existing kernel: request-scoped tenant authority, JWT/OIDC authentication, Postgres-backed (tenant, user)-keyed state, a Docker/Podman container execution world, and a stateless HTTP API. Isolation is a property of these providers plus the tenant authority, not a change to the core session/persistence seams.

| Package | Role | ctx key |
|---|---|---|
| [`tenant/`](tenant/README.md) | Tenant identity, request-scoped authority, and record registry | `ctx.tenants` |
| `tenant-auth/` | Authentication Service Definition (`TenantAuthenticator`) | `ctx.tenantAuth` |
| `tenant-auth-jwt/` | JWT/OIDC verification provider | — |
| `session-persistence-postgres/` | `SessionPersistence` over Postgres, (tenant, user)-keyed | `ctx.sessionPersistence` |
| `storage-postgres/` | Storage hub backend over Postgres, (tenant, user)-keyed (case-shared units store per tenant) | registers backend `postgres` |
| `container/` | Container owner Service Definition | `ctx.containerRuntime` |
| `container-docker/` | Docker/Podman engine lifecycle provider | — |
| `fs-container/` | `FileSystem` over the tenant container | `ctx.fs` |
| `subprocess-container/` | `SubprocessRuntime` over the tenant container | `ctx.subprocess` |
| `api-http/` | Stateless HTTP API backend + authentication middleware | HTTP routes |
| `tenant-demo/` | Runnable end-to-end slice assembly + isolation test | HTTP routes |

Provider names in this group are tenant- and user-aware by contract: each calls `requireTenant()` (plus `requireUser()` for per-user state) or reads the `(tenant, user)` the session controller captured, and enforces the durable `tenant_id`/`user_id`/schema binding it owns. They are not drop-in replacements for the single-tenant backends in `session/`, `storage/`, and `fs/`/`subprocess/`, which remain untouched.
