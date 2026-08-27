# Agent Note: Multi-tenant isolation for DeepSeek Harness

Status: proposed

English | [中文](2026-08-24-multi-tenant-isolation.zh.md)

## Problem

DeepSeek Harness is single-tenant today. One booted process resolves every durable fact from one harness home (`resolveDshHome`/`dshHomePath`): `settings.yaml`, `.credentials.yaml`, `.anonymous-user-id`, `skills/`, `AGENTS.md`, session logs (`dshHomePath('sessions')`), and storage domains (`dshHomePath('storages')`). The three wire surfaces — the stdio JSON-RPC runtime (`packages/sdk`), the ACP stdio server, and the HTTP API (`host/webserver` + `host/apiproxy` + `client/connection`) — all bind one `cwd`/credential set per process and carry no client authentication; the only "auth-like" code is a DNS-rebinding trust fence that its own comments call "explicitly not authentication". Session ids are one per-process namespace; `session.list`/`search` and `sessionLog` resolve by raw id with no ownership filter.

An enterprise deployment must serve many tenants behind one stateless API with **strict** isolation of sessions, memory, tools, and skills, and run each tenant's tool calls in that tenant's own container with only that tenant's workspace and tools mounted. The motivating shape: agent functionality becomes stateless middleware with state externalized to a shared store, fronted by an HTTP API, with per-tenant container-isolated tool execution.

## Proposal

Add a `packages/tenant/` group that layers multi-tenancy on the existing kernel without changing the single-tenant spine. Isolation is a property of the new providers plus a request-scoped tenant authority, not a change to the core session/persistence seams. The vertical slice described below has shipped; what is built and what remains deferred is recorded in the [implementation note](../../implemented/architecture/2026-08-24-multi-tenant-slice.md).

### Tenant identity and request-scoped authority

`@deepseek-ai/dsh-tenant` owns the identity vocabulary and the authority. `TenantId` is a `Branded<'TenantId'>` id; a `Tenant` is the resolved record an authenticated request acts as:

```ts
declare const tenantIdBrand: unique symbol
type TenantId = string & { readonly [tenantIdBrand]: 'TenantId' }

interface Tenant {
  readonly id: TenantId
  readonly name: string
  /** Root for tenant-private files, credentials, settings, and skills. */
  readonly dataRoot: string
  /** Host directory bind-mounted into the tenant container at a fixed path. */
  readonly workspaceRoot: string
  /** Optional host directory of tenant-provided tooling, bind-mounted read-only. */
  readonly toolsRoot?: string
  readonly containerImage: string
  readonly enabled?: boolean
  readonly network?: 'none' | 'internal'
}
```

`TenantContext` is an `AsyncLocalStorage`-backed library primitive (the `dsh-scope` pattern): `runWith(tenant, fn)` enters a tenant for the synchronous/asynchronous tree of one request, `current()` returns `Tenant | undefined`, `require()` returns the tenant or throws `NO_TENANT_IN_SCOPE`. `TenantRegistry` (`ctx.tenants`) holds the deployment's tenant records, resolves an authenticated id to a live `Tenant`, and rejects absent or disabled tenants fail-closed.

The request-scoped context is the authority for *open* operations — `SessionPersistence.load/inspect/list`, storage-domain opens, and container acquisition. The per-session durable binding (below) is the authority for *async flush* work that outlives the request fiber.

### Package topology

| Package | Path | Surface | Role |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-tenant` | `tenant/` | `ctx.tenants`, `ctx.tenantContext` | identity, records, request-scoped authority |
| `@deepseek-ai/dsh-tenant-auth` | `tenant-auth/` | `ctx.tenantAuth` | auth Service Definition |
| `@deepseek-ai/dsh-tenant-auth-jwt` | `tenant-auth-jwt/` | registers a provider | JWT/OIDC verification → tenant id |
| `@deepseek-ai/dsh-session-persistence-postgres` | `session-persistence-postgres/` | `ctx.sessionPersistence` | tenant-keyed Postgres session log |
| `@deepseek-ai/dsh-storage-postgres` | `storage-postgres/` | registers backend `postgres` | tenant-keyed KV storage hub backend |
| `@deepseek-ai/dsh-container` | `container/` | `ctx.containerRuntime` | container owner Service Definition |
| `@deepseek-ai/dsh-container-docker` | `container-docker/` | registers a provider | Docker/Podman engine lifecycle |
| `@deepseek-ai/dsh-fs-container` | `fs-container/` | `ctx.fs` | `FileSystem` over the tenant container |
| `@deepseek-ai/dsh-subprocess-container` | `subprocess-container/` | `ctx.subprocess` | `SubprocessRuntime` over the tenant container |
| `@deepseek-ai/dsh-api-http` | `api-http/` | HTTP routes | stateless HTTP API + auth middleware |
| `@deepseek-ai/dsh-tenant-demo` | `examples/tenant-demo/` | bin | keyless end-to-end composition |

`storage-domain` (existing) is reused unchanged: its `routes`/`backend` config points `workspace`, `session_projcache`, `message-feedback`, and any tenant memory domains at the `postgres` backend.

### Strict isolation invariant

The isolation invariant is enforced at two points that must agree:

1. **Ambient authority** — `ctx.tenantContext.require()` supplies the tenant for every open operation. It originates only from authentication (`ctx.tenantAuth`), never from client input, a URL segment, or a session id.
2. **Durable binding** — the Postgres providers write `tenant_id` on every row and scope every statement by it. Each tenant also owns its own schema (below), so a missing `tenant_id` predicate still cannot read another tenant's tuples.

The two must agree when both are visible: a loaded session whose rows carry a different `tenant_id` than the ambient tenant is a failed invariant, reported as an isolation violation, never silently served. Cross-tenant access is unrepresentable because the only way to address tenant B's tuples is to hold tenant B's ambient authority, which only `ctx.tenantAuth` can mint from a valid JWT.

### Stateless middleware and Postgres state

Sessions and memory live in Postgres, so API replicas are interchangeable. The Postgres session backend implements the `SessionPersistence` seam keyed by tenant: one schema per tenant (a sanitized, tenant-id-derived schema name), `tenant_id` columns, and a per-session-controller capture of the tenant at `create`/`load` so late asynchronous flushes (`session/flush` after the request fiber unwinds) still write to the correct tenant. `list()` filters by the ambient tenant. The storage backend is the analogous `KvFacet` implementation over the same tenant schema; settings and credentials files live under `Tenant.dataRoot`.

No core change: `SessionHeader`, `SESSION_FORMAT_VERSION`, and the JSONL/SQLite backends are untouched. Single-tenant assemblies keep working unchanged.

### Container-isolated execution world

The portable-execution-world contract (`ctx.fs` + `ctx.subprocess` = one world) makes the container swap three packages, mirroring the E2B POC:

- `@deepseek-ai/dsh-container` — the owner seam (`ctx.containerRuntime`): `acquire(tenant)` returns a live `ContainerHandle` (id, engine handles, `exec`), reusing one container per tenant across its tool calls, with idle-timeout disposal.
- `@deepseek-ai/dsh-container-docker` — creates/removes containers via the Docker Engine API. Each container bind-mounts `Tenant.workspaceRoot` → `/workspace` (read-write) and `Tenant.toolsRoot` → `/tools` (read-only), and starts with `Tenant.network` egress policy.
- `@deepseek-ai/dsh-fs-container` + `@deepseek-ai/dsh-subprocess-container` — the two execution-world providers. `fs-container` maps agent-facing host paths into `/workspace`/`/tools` and rejects anything outside (the container boundary), and `subprocess-container` runs `argv` inside the container via the owner `exec` with `cwd` remapped.

`ctx.sandbox`/`ctx.sandboxPolicy` are not used in a container world — the container itself is the boundary. Replacing `fs-local`/`subprocess-local` with the container pair moves Bash, PTY, LSP, and terminal consumers into the tenant container with no consumer code change; `ctx.codeRuntime` remains a separate seam.

### HTTP API and authentication

The backend reuses the JSON-RPC/`session` vocabulary but on an HTTP carrier: a `node:http` server exposing `session/prompt` (request) and a streaming `session.event` downlink (SSE frames), plus tenant/session listing methods. A Bearer-token middleware (`ctx.tenantAuth`) verifies the JWT, resolves the tenant via `ctx.tenants`, enters `ctx.tenantContext.runWith(tenant, …)`, then creates or resumes the agent inside that authority. No request field addresses a tenant directly; the token is the only tenant source.

### End-to-end data flow

`HTTP request (Authorization: Bearer) → ctx.tenantAuth.authenticate → TenantId → ctx.tenants.resolve → ctx.tenantContext.runWith → agent create/resume (Postgres, tenant schema) → turn → tool call → ctx.shell/ctx.fs → container fs/subprocess providers (mounted /workspace + /tools) → durable session events (Postgres) → SSE to client`.

## Alternatives considered

- **Add `tenantId` to `SessionHeader` and thread it through core** — real durable audit, but it is a `SESSION_FORMAT_VERSION`-adjacent change that touches `core/session` validation, JSONL header lines, SQLite columns, projection-cache checkpoint identity, and every backend. Layering the binding in tenant-scoped providers achieves the same isolation with zero core change; the `tenant_id` column is the durable audit. Rejected for now; revisit if cross-backend tenant audit becomes a requirement.
- **Reuse `host/webserver` + `host/apiproxy` + `client/connection`** — the richest HTTP surface and already transport-agnostic, but it carries the browser roster (WebSocket downlinks, `PRIVILEGED_METHODS` loopback gating, DNS-rebinding trust) that a programmatic enterprise API does not need and whose trust model must be replaced wholesale. A smaller dedicated HTTP backend keeps the auth boundary explicit and testable. Rejected for the first slice; the ApiProxy reuse seams noted for a later parity phase.
- **Shared single Postgres database with `tenant_id` only** — cheapest, but a single dropped predicate is a cross-tenant leak. Per-tenant schemas make the boundary structural; schemas are the middle ground over database-per-tenant (which multiplies connection state). Chosen: schema per tenant plus `tenant_id` columns for defense-in-depth.
- **E2B / Firecracker / same-kernel `ctx.sandbox`** — E2B is hosted and ephemeral; Firecracker is heavier infra; `ctx.sandbox` is same-kernel and cannot give the per-tenant mount boundary. Local Docker/Podman matches on-prem enterprise and gives the bind-mount model directly. Chosen per operator decision.
- **One container per tool call** — strongest short-lived isolation but re-pays image/start latency per call and loses the mounted-workspace persistence the operator described. Chosen: one persistent container per tenant (with idle disposal), which is also what "each container mounts the user's workspace and tools" requires.

## Acceptance criteria

- `packages/tenant/` group exists with the packages above; `packages/README.md` and the group README own the ctx-key map.
- `dsh-tenant` ships `TenantId`, `TenantContext` (`runWith`/`current`/`require`), and `TenantRegistry` with tests proving `require()` fails closed outside a run.
- A keyless `tenant-demo` boots an assembly where an arbitrary bearer token (dev JWT) resolves a tenant, a prompt turn emits durable session events into that tenant's Postgres schema, and a `bash`/`fs` tool call executes inside that tenant's Docker container with `/workspace`+`/tools` mounted.
- Strict-isolation tests prove: a session id in tenant A is absent for tenant B; `list()` returns only the ambient tenant's sessions; a container cannot address a path outside `/workspace`/`/tools`; an unauthenticated or cross-tenant request is rejected by the auth middleware.
- Postgres and container providers fail loud (never fall through to host filesystem/processes) when their backend is unreachable.

## Risks

- **Async flush outliving the request** — `session/flush` can run after `runWith` unwinds; the mitigation (capture tenant per session controller at `create`/`load`) must be proven by a test that appends, resolves the request, then forces a flush and asserts the correct tenant schema.
- **Docker daemon coupling and path mapping** — host↔container path mapping and bind-mount semantics are where subtle escapes live; `fs-container` rejects any path outside the two mounts and the acceptance tests drive denial through the executor, not the mapping helper.
- **Schema-per-tenant lifecycle** — creating/dropping tenant schemas on provision/de-provision is new operational surface; the slice keeps creation on first write and documents the administrative contract.
- **Scope** — ten packages plus a demo is a multi-round effort; the vertical slice is the completeness line, breadth (all storage domains, terminal over container, `code-runtime` container provider, ACP parity) is explicit follow-up.