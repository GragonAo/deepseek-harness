# 多租户隔离

[English](multi-tenant.md) | 中文

多租户子系统把租户隔离叠加在单租户 harness 之上而不改其 core。一个已认证的请求解析到单个 `Tenant`，每个租户感知的 provider 都读取该请求作用域权威，持久后端各自强制一个按租户的分区，因此请求只能寻址其凭据所证明的租户。设计理由与被否掉的备选见[多租户隔离 Agent Note](../../.agents/notes/proposed/architecture/2026-08-24-multi-tenant-isolation.md)；已交付的切片见[多租户切片 Agent Note](../../.agents/notes/implemented/architecture/2026-08-24-multi-tenant-slice.md)。

## 身份与权威

[`dsh-tenant`](../../packages/tenant/tenant) 拥有身份词汇与请求作用域权威。`TenantId` 是带品牌 id；`Tenant` 是认证请求所充当的、已解析的记录——其工作空间根、数据根、容器镜像，以及可选的工具根与出网策略。一个模块级的 `AsyncLocalStorage` 即权威：`runWithTenant(tenant, fn)` 为一次请求的同步/异步树进入租户，`requireTenant()` 返回它或以 `TenantError` 代码 `NO_TENANT_IN_SCOPE` 抛出，`TenantRegistry`（`ctx.tenants`）把认证 id 解析为活的 `Tenant`，对未知或已禁用租户失败关闭。`tenantPartitionName(id)` 派生每个租户的确定性存储分区（schema）名。

## 认证

[`dsh-tenant-auth`](../../packages/tenant/tenant-auth) 定义 `ctx.tenantAuth` 接缝：`authenticate(credential)` 校验 bearer 凭据并返回 `TenantPrincipal`（`tenantId`、`subject`、可选 scopes）。已交付的 [`dsh-tenant-auth-jwt`](../../packages/tenant/tenant-auth-jwt) provider 校验 RS256 JWKS 或 HS256 共享密钥 token，并按模式锁定算法。

## 租户作用域状态

两个 Postgres provider——[`dsh-storage-postgres`](../../packages/tenant/storage-postgres) 与 [`dsh-session-persistence-postgres`](../../packages/tenant/session-persistence-postgres)——把每个租户的数据存在该租户自己的 `tenantPartitionName` schema 中。读在调用入口解析 `requireTenant()`；会话写额外捕获持有租户，使活过请求的异步 flush 仍落到正确的 schema。

## 租户作用域执行世界

[`dsh-container`](../../packages/tenant/container) 定义 `ctx.containerRuntime` 接缝。[`dsh-container-docker`](../../packages/tenant/container-docker) provider 为每个租户启动一个容器（工作空间绑定挂载于 `/workspace`、工具只读挂载于 `/tools`），[`dsh-subprocess-container`](../../packages/tenant/subprocess-container) 与 [`dsh-fs-container`](../../packages/tenant/fs-container) provider 则把进程与文件操作委托进这同一个世界。

## HTTP 表面

[`dsh-api-http`](../../packages/tenant/api-http) 暴露一条路由（`ctx.tenantHttpApi`）：认证、解析租户、进入 `runWithTenant`、运行已注册的操作。

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