# @deepseek-ai/dsh-tenant

English | [中文](README.zh.md)

Tenant identity, request-scoped authority, and registry for multi-tenant DeepSeek Harness deployments. This package owns nothing durable and registers no tools; it is the boundary the multi-tenant providers read.

## Shape

- `TenantId` — an opaque `Branded<'TenantId'>` id with the `TenantId(id)` factory; `UserId` — an opaque `Branded<'UserId'>` subject with the `UserId(id)` factory.
- `Tenant` — the resolved record an authenticated request acts as: `id`, `name`, `dataRoot`, `workspaceRoot`, optional `toolsRoot`, optional `enabled`, optional `network` egress policy, and optional `members` (the admitted subjects; absent or empty means open to any authenticated subject).
- `runWithTenant(tenant, fn)` / `currentTenant()` / `requireTenant()` — the request-scoped tenant authority; `runWithUser(user, fn)` / `currentUser()` / `requireUser()` carry the authenticated subject the same way. Each authority is one module `AsyncLocalStorage` (the `withInitiator` pattern), so every tenant- or user-aware provider reads the same store. `requireTenant()` throws `TenantError` code `NO_TENANT_IN_SCOPE` and `requireUser()` throws `NO_USER_IN_SCOPE` outside any run.
- `isTenantMember(tenant, subject)` — whether a subject is admitted to a tenant: `members` absent or empty is open, otherwise the subject must be listed.
- `tenantPartitionName(tenantId)` / `userPartitionName(user)` — deterministic storage-partition names: a sanitized id prefix plus a collision-resistant hash suffix, always a safe PostgreSQL identifier (≤63 chars). The tenant name is the per-tenant schema the Postgres backends use; the user name is the safe token form of the durable `user_id` used for in-memory guard keys and container names.
- `TenantRegistry` (`ctx.tenants`) — the deployment's tenant records: `register(tenant)` returns the exact disposer, `get`, `resolve` (rejects `TENANT_UNKNOWN` / `TENANT_DISABLED` fail-closed), `resolveMember(id, subject)` (adds `NOT_A_MEMBER` when the tenant lists members excluding the subject), and `list`. Tenants can also be declared in cordis.yml through `Config.tenants` (a `{ id, name, dataRoot, workspaceRoot, toolsRoot?, enabled?, network?, members? }` wire shape whose `id` is brand-cast to `TenantId` on registration); each record mounts as an effect.

Isolation is layered here, not in core: multi-tenant providers call `requireTenant()` for every open operation and enforce the durable `tenant_id`/schema binding they own, so a request can only address the tenant its authentication minted.

## Model Experience

### Tenant resolution and registry

#### What the model sees

Nothing. `ctx.tenants` and the tenant authority serve host-side providers only: the package registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **Tenant records are in-memory** — provisioning is registration in the assembly, not a durable store; durable tenant provisioning and de-provisioning (with schema lifecycle) is deferred to the Postgres providers and their administrative contract.
- **The authority is process-local** — `AsyncLocalStorage` propagates within one Node.js process; cross-replica fan-out carries the tenant id on the wire and re-enters with `runWithTenant` on the receiving side.