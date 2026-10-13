# Agent Note: Multi-tenant isolation vertical slice

Status: implemented

English | [中文](2026-08-24-multi-tenant-slice.zh.md)

## Problem

DeepSeek Harness is single-tenant: one booted process resolves every durable fact from one harness home, and the stdio/ACP/HTTP surfaces carry no client authentication, so sessions, storage, and files are addressed by raw id with no ownership filter. An enterprise deployment must serve many tenants behind one stateless API with strict isolation of sessions and memory, and run each tenant's tool calls inside that tenant's own container. The full design — motivation, package rationale, rejected alternatives, and the breadth deferred beyond the slice — lives in the [proposed note](../../proposed/architecture/2026-08-24-multi-tenant-isolation.md). This note records the vertical slice that shipped: the first delivery proves the isolation invariant end to end.

## Decision

Ship `packages/tenant/` as a keyless end-to-end slice: bearer-JWT authentication, tenant resolution, tenant-scoped sessions in Postgres, and tenant-scoped container tool execution, layered on the existing capability seams with zero change to the single-tenant core.

### Shipped packages

| Package | Path | ctx key | Role |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-tenant` | `tenant/` | `ctx.tenants` | `TenantId`/`UserId`/`Tenant`/`TenantError`, `runWithTenant`/`requireTenant`/`currentTenant`, `runWithUser`/`requireUser`/`currentUser`, `tenantPartitionName`, `isTenantMember`, `TenantRegistry` (`resolve`/`resolveMember`) |
| `@deepseek-ai/dsh-tenant-auth` | `tenant-auth/` | `ctx.tenantAuth` | `TenantAuthenticator` Service Definition |
| `@deepseek-ai/dsh-tenant-auth-jwt` | `tenant-auth-jwt/` | registers a provider | JWT (HS256/RS256) verification → tenant id |
| `@deepseek-ai/dsh-session-persistence-postgres` | `session-persistence-postgres/` | `ctx.sessionPersistence` | tenant-keyed Postgres session log |
| `@deepseek-ai/dsh-storage-postgres` | `storage-postgres/` | registers backend `postgres` | tenant-keyed KV storage backend |
| `@deepseek-ai/dsh-container` | `container/` | `ctx.containerRuntime` | container owner Service Definition |
| `@deepseek-ai/dsh-container-docker` | `container-docker/` | registers a provider | Docker/Podman engine lifecycle |
| `@deepseek-ai/dsh-fs-container` | `fs-container/` | `ctx.fs` | `FileSystem` over the tenant container |
| `@deepseek-ai/dsh-subprocess-container` | `subprocess-container/` | `ctx.subprocess` | `SubprocessRuntime` over the tenant container |
| `@deepseek-ai/dsh-agent-http` | `agent-http/` | `ctx.agentHttp` | business HTTP surface at `/api` over `ctx.apiProxy`, bearer-authenticated |
| `@deepseek-ai/dsh-tenant-admin-http` | `tenant-admin-http/` | `ctx.tenantAdminHttp` | management surface at `/admin`, gated by the administrative scope |
| `@deepseek-ai/dsh-tenant-app` | `tenant-app/` | — | the composition entry: the `dsh-tenant` bin, its typed config, and the plugin inventory |

### Deviations from the proposal, shipped as-is

- **Tenant authority is module-level in `dsh-tenant`, not a `ctx.tenantContext` service.** `runWithTenant(tenant, fn)`, `requireTenant()`, and `currentTenant()` are `AsyncLocalStorage`-backed exports; `requireTenant()` throws `TenantError` `NO_TENANT_IN_SCOPE` outside a run. `TenantRegistry` is the `ctx.tenants` service.
- **`ctx.containerRuntime` is an `exec` surface, not `acquire`/`handle`.** `ContainerRuntime.exec(command, args, opts)` returns `{ exitCode, stdout, stderr }`. `DockerContainerRuntime` lazily starts one `docker run -d … tail -f /dev/null` container per tenant partition (workspace bind-mounted at `/workspace`, optional tooling at `/tools` read-only), `docker exec -i`s each call, and `docker rm -f`s on dispose. Idle-timeout disposal is deferred.
- **The HTTP face is two carriers, split by the authority each one proves.** `ctx.agentHttp` serves the business surface at `/api`: authenticate, resolve the tenant, check membership, enter `runWithTenant` + `runWithUser`, and delegate to `ctx.apiProxy`; a credential that proves no tenant is refused with 401. `ctx.tenantAdminHttp` serves the management surface at `/admin` as `POST /admin/<method>`, gated by the administrative scope alone, so an operator administers every tenant with a platform credential and needs membership in none. A JSON-RPC/`session` vocabulary with an SSE downlink remains deferred.
- **The composition lives in `packages/tenant/tenant-app/`, not in an `examples/` bundle.** `createTenantApp` mounts the tenant stack on one Cordis context from a typed config file plus a plugin inventory, and the `dsh-tenant` bin boots it with no dsh bundle, CLI, or Loader. Its hermetic boot test serves real HTTP with every inventory row disabled and asserts the management surface refuses an unproven credential.

### Isolation invariant

Isolation is enforced at two points that agree, per the design:

1. **Ambient authority** — `requireTenant()` is the only tenant source for open operations; it originates only from `ctx.tenantAuth`, never from a URL segment, a session id, or a request body.
2. **Durable binding** — the Postgres backends write a `tenant_id` on every row, scope every statement by it, and put each tenant in its own schema (`tenantPartitionName`). Schema-per-tenant makes a dropped predicate still unable to read another tenant's tuples.

Async flush outliving the request fiber is covered by a per-session-controller binding map captured at `create`/`load`, so a late `session/flush` writes to the tenant that opened the session, not to ambient scope.

## Alternatives considered

The full set, with the reasoning each lost, is in the proposed note. The decisions this slice commits to:

- **Layering in tenant-scoped providers vs. threading `tenantId` through core `SessionHeader`** — layering gives the same isolation with zero core change; the `tenant_id` column is the durable audit. Chosen: layering.
- **Schema-per-tenant plus `tenant_id` vs. `tenant_id` only or database-per-tenant** — schema-per-tenant makes the boundary structural; the column is defense-in-depth. Chosen: schema + column.
- **Local Docker/Podman bind-mounts vs. E2B/Firecracker/`ctx.sandbox`** — Docker matches on-prem and gives the bind-mount model directly. Chosen: Docker/Podman.
- **Dedicated single-slot HTTP backend vs. reusing `host/webserver`+`host/apiproxy`** — the ApiProxy carries browser-roster trust that must be replaced wholesale; a small backend keeps the auth boundary explicit. Chosen: dedicated backend, with ApiProxy reuse noted for a parity phase.

## Consequences

**Bought:** a runnable proof that one process serves two tenants with separate containers, separate host workspaces, separate Postgres schemas, and shared-session-id opacity, behind a stateless bearer-authenticated route; the single-tenant core, the E2B-style portable-execution-world swap, and the existing backends are untouched.

**Cost and deferred work:** the boot test drives no LLM turn; the HTTP face carries no JSON-RPC/`session` vocabulary with an SSE downlink; container idle-timeout disposal, all storage domains and credentials under `dataRoot`, terminal/LSP/`code-runtime` container providers, and ACP parity are explicit follow-up recorded in the proposed note's scope risk.

### Verification

`pnpm exec tsc -b tsconfig.host.json` and `pnpm run typecheck` pass (host and client faces). 54 unit tests across the 11 packages pass. `tenant-demo`'s end-to-end suite (self-skipping without `TEST_POSTGRES_URL` and a reachable container runtime) was run for real on 2026-08-24 against PostgreSQL 16 and Docker: the `acme` and `globex` requests return their own markers, host workspaces stay physically separate, `sessionPersistence.list()` shows each tenant only its own sessions, and a credential for an unregistered tenant is rejected with `TENANT_UNKNOWN` (403).
