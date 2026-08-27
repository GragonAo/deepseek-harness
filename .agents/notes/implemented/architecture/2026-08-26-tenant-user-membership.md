# Agent Note: Tenant user identity and membership authority

Status: implemented

English | [中文](2026-08-26-tenant-user-membership.zh.md)

## Problem

The multi-tenant slice ([2026-08-24](2026-08-24-multi-tenant-slice.md)) made each tenant the isolation unit but left the authenticated subject unused: `tenant-auth-jwt` returns the JWT `sub` on the principal, yet nothing after authentication reads `subject` for authorization. Every tenant is therefore one shared world — all subjects admitted to a tenant act in the same workspace, storage schema, and container — so a tenant with several collaborators cannot keep per-user sessions, memory, and files apart, and a tenant cannot admit only some authenticated subjects.

Cross-box identity is the JWT `sub` (an OIDC subject). "Case" collapsed into tenant (one concept, no separate case layer); the user is the cross-box subject. Per-user isolation is therefore the pair `(tenant, subject)`, added as a second request-scoped authority layered inside the tenant authority — not a case entity and not a new partition-name function.

## Decision

Extend `@deepseek-ai/dsh-tenant` with a user authority and per-tenant membership, enforced in the carrier:

- `UserId` (`Branded<'UserId'>`) with the `UserId(id)` factory, and `Tenant.members?: readonly string[]` (the admitted subjects).
- `runWithUser(user, fn)` / `currentUser()` / `requireUser()` — a second module `AsyncLocalStorage`, layered over `runWithTenant`. `requireUser()` throws `TenantError` `NO_USER_IN_SCOPE` outside any run.
- `isTenantMember(tenant, subject)` — `members` absent or empty is open; otherwise the subject must be listed.
- `TenantRegistry.resolveMember(id, subject)` — `resolve` plus the membership gate, throwing `TenantError` `NOT_A_MEMBER`; `Config.tenants` gains a `members?: string[]` wire field that registration passes through to the record.
- `@deepseek-ai/dsh-agent-http` resolves the tenant through `resolveMember(principal.tenantId, UserId(principal.subject))` and enters `runWithTenant` + `runWithUser` before delegating, so `NOT_A_MEMBER` is a 403 alongside `TENANT_UNKNOWN`/`TENANT_DISABLED`, and the user-scoped providers behind the gateway resolve `requireUser()`.
- `@deepseek-ai/dsh-agent-http` also scopes the cross-session channels it exposes to the ambient `(tenant, user)`: a live-session ownership map `sessionScopes: Map<string, { tenant, user }>` (fed by `session/created` under `currentTenant()` + `currentUser()`, released on `session/disposed`) backs `owns(sessionId, tenantId, user)`, true for a cold session (no live owner) or a matching live owner; `session.list`/`session.search` items and the `events.mux`/`events.host` session-scoped frames filter through it.

The per-user partitions read this seam: the durable `(tenant, user)` keys in [2026-08-26](2026-08-26-per-user-storage-partition.md), the `(tenant, subject)` container key with three-layer mounts in `@deepseek-ai/dsh-container-docker`, and the carrier's session-to-user ownership above.

## Alternatives considered

- **Required `members` (`.min(1)`, fail-loud)** — rejects: the tenant record mirrors the `enabled?`/`toolsRoot?` optional-permissive fields, and a required list would force every non-carrier fixture to fabricate one; deployments set `members` explicitly regardless.
- **Empty list means "closed to all"** — rejects: absent-vs-empty carries the footgun that `members: []` silently locks out every subject; treating both as open keeps the gate symmetric and leaves "disable everyone" to `enabled: false`.
- **Gate membership in each per-user storage provider instead of the carrier** — rejects: the carrier is the single authenticated entry; enforcing once there (with `resolveMember` as the carrier's only resolve path) is one enforcement point, not N.

## Consequences

- The request-scoped user is now available to the Postgres session, storage, settings, and credentials providers, so per-user partitioning becomes a column/primary-key change, not a new authority.
- The carrier now authorizes, not just authenticates: a non-member subject is rejected `NOT_A_MEMBER` (403) before any method runs.
- A tenant whose operator leaves `members` unset is open to any authenticated subject; production sets it (recorded in the package README).

### Verification

- `packages/tenant/tenant/tests/tenant.spec.ts` adds user-authority, `isTenantMember`, `resolveMember`, and config-`members` pass-through cases; `packages/tenant/agent-http/tests/agent-http.spec.ts` adds the non-member 403 and pins the `(tenant, user)` scoping of `session.list`/`session.search` items and the `events.mux`/`events.host` session-scoped frames. `tsc -b` on the tenant group passes.
