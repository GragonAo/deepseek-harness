# Multi-tenant isolation

English | [中文](multi-tenant.zh.md)

The multi-tenant subsystem overlays tenant isolation on the single-tenant harness without changing its core. One authenticated request resolves to a single `Tenant`, every tenant-aware provider reads that request-scoped authority, and the durable backends each enforce a per-tenant partition, so a request can only ever address the tenant its credential proves. Design rationale and rejected alternatives: [multi-tenant isolation Agent Note](../../.agents/notes/proposed/architecture/2026-08-24-multi-tenant-isolation.md); the shipped slice: [multi-tenant slice Agent Note](../../.agents/notes/implemented/architecture/2026-08-24-multi-tenant-slice.md).

## Identity and authority

[`dsh-tenant`](../../packages/tenant/tenant) owns the identity vocabulary and the request-scoped authority. `TenantId` is a branded id; `Tenant` is the resolved record an authenticated request acts as — its workspace root, data root, container image, and optional tooling root and egress policy. One module-scoped `AsyncLocalStorage` is the authority: `runWithTenant(tenant, fn)` enters a tenant for one request's synchronous/asynchronous tree, `requireTenant()` returns it or throws `TenantError` code `NO_TENANT_IN_SCOPE`, and `TenantRegistry` (`ctx.tenants`) resolves an authenticated id to a live `Tenant`, rejecting unknown or disabled tenants fail-closed. `tenantPartitionName(id)` derives each tenant's deterministic storage-partition (schema) name.

## Authentication

[`dsh-tenant-auth`](../../packages/tenant/tenant-auth) defines the `ctx.tenantAuth` seam: `authenticate(credential)` verifies a bearer credential and returns a `TenantPrincipal` (`tenantId`, `subject`, optional scopes). The shipped [`dsh-tenant-auth-jwt`](../../packages/tenant/tenant-auth-jwt) provider verifies RS256 JWKS or HS256 shared-secret tokens, pinning the algorithm per mode.

## Tenant-scoped state

Two Postgres providers — [`dsh-storage-postgres`](../../packages/tenant/storage-postgres) and [`dsh-session-persistence-postgres`](../../packages/tenant/session-persistence-postgres) — store each tenant's data in its own `tenantPartitionName` schema. Reads resolve `requireTenant()` at call entry; session writes additionally capture the owning tenant so an asynchronous flush that outlives the request still lands in the right schema.

## Tenant-scoped execution world

[`dsh-container`](../../packages/tenant/container) defines the `ctx.containerRuntime` seam. The [`dsh-container-docker`](../../packages/tenant/container-docker) provider starts one container per tenant (workspace bind-mounted at `/workspace`, tooling read-only at `/tools`), and the [`dsh-subprocess-container`](../../packages/tenant/subprocess-container) and [`dsh-fs-container`](../../packages/tenant/fs-container) providers delegate process and file operations into that same world.

## HTTP surface

[`dsh-api-http`](../../packages/tenant/api-http) exposes one route (`ctx.tenantHttpApi`): authenticate, resolve the tenant, enter `runWithTenant`, and run the registered operation.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagenthttp--agenthttp"></a>

### `ctx.agentHttp` — `AgentHttp`

Multi-tenant carrier registered as `ctx.agentHttp`.

```ts cordis-catalog
/**
 * Authenticate one request and answer it through the shared gateway under
 * the resolved tenant's authority. Authentication and tenant resolution fail
 * closed before any method runs.
 * @param request - the incoming Fetch request (unary RPC or SSE channel).
 * @returns the gateway's response, or a 401/403/500 fail-closed rejection.
 */
async fetch(request: Request): Promise<Response>
```

Source: [`packages/tenant/agent-http/src/index.ts:66`](../../packages/tenant/agent-http/src/index.ts)

<a id="ctxcontainerruntime--containerruntime-abstract-seam"></a>

### `ctx.containerRuntime` — `ContainerRuntime` (abstract seam)

Abstract container runtime (`ctx.containerRuntime`). A provider runs commands inside the ambient tenant's container — the container whose `/workspace` binds that tenant's workspace root and `/tools` binds its tooling — resolved per call from `requireTenant()`.

```ts cordis-catalog
/**
 * Run one command in the ambient tenant's container and capture its streams.
 * @param command - the executable inside the container.
 * @param args - positional arguments (never shell-interpreted here).
 * @param opts - optional stdin feed and cancellation.
 * @returns the command's exit code and captured stdout/stderr.
 * @throws `TenantError` code `NO_TENANT_IN_SCOPE` outside an authenticated request.
 */
abstract exec( command: string, args: readonly string[], opts?: ContainerExecOptions, ): Promise<ContainerCommandResult>
```

Source: [`packages/tenant/container/src/index.ts:45`](../../packages/tenant/container/src/index.ts)

<a id="ctxtenantauth--tenantauthenticator-abstract-seam"></a>

### `ctx.tenantAuth` — `TenantAuthenticator` (abstract seam)

Abstract tenant authenticator (`ctx.tenantAuth`). Subclass, implement authenticate, and load the subclass as a plugin.

```ts cordis-catalog
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
```

Source: [`packages/tenant/tenant-auth/src/index.ts:52`](../../packages/tenant/tenant-auth/src/index.ts)

<a id="ctxtenanthttpapi--tenanthttpapi"></a>

### `ctx.tenantHttpApi` — `TenantHttpApi`

Stateless tenant HTTP API registered as `ctx.tenantHttpApi`.

```ts cordis-catalog
/**
 * Register the single request operation and its HTTP route.
 * @param operation - the tenant-scoped request operation.
 * @returns the disposer removing both the operation and its route.
 */
register(operation: TenantOperation): () => void
```

Source: [`packages/tenant/api-http/src/index.ts:73`](../../packages/tenant/api-http/src/index.ts)

<a id="ctxtenants--tenantregistry"></a>

### `ctx.tenants` — `TenantRegistry`

Tenant record registry (`ctx.tenants`). Records are registered by the deployment assembly — from cordis.yml through Config.tenants, or by calling register directly — and authentication resolves an authenticated id through resolve, which rejects absent or disabled tenants fail-closed.

```ts cordis-catalog
/**
 * Register one tenant record. Returns the exact disposer that removes it.
 * @param tenant - the tenant record.
 * @returns the disposer.
 * @throws `TenantError` code `DUPLICATE_TENANT` when the id exists.
 */
register(tenant: Tenant): () => void

/**
 * Look up a registered record without failing on its absence.
 * @param id - the tenant id.
 * @returns the record, or undefined when unknown.
 */
get(id: TenantId): Tenant | undefined

/**
 * Resolve an authenticated id to a live tenant, failing closed.
 * @param id - the authenticated tenant id.
 * @returns the record.
 * @throws `TenantError` code `TENANT_UNKNOWN` when unregistered, or
 *   `TENANT_DISABLED` when the record is disabled.
 */
resolve(id: TenantId): Tenant

/**
 * Resolve an authenticated id to a live tenant, then fail closed when the
 * subject is not a member of it. The membership gate is here, on top of
 * {@link resolve}, so the carrier authenticates and authorizes in one call.
 * @param id - the authenticated tenant id.
 * @param subject - the authenticated subject.
 * @returns the record.
 * @throws `TenantError` code `TENANT_UNKNOWN`/`TENANT_DISABLED`, or
 *   `NOT_A_MEMBER` when the tenant lists members excluding this subject.
 */
resolveMember(id: TenantId, subject: UserId): Tenant

/**
 * All registered records in registration order.
 * @returns a fresh array.
 */
list(): Tenant[]
```

Source: [`packages/tenant/tenant/src/index.ts:273`](../../packages/tenant/tenant/src/index.ts)
<!-- END GENERATED cordis-surface -->