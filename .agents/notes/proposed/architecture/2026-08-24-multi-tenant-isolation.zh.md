# Agent Note: DeepSeek Harness 多租户隔离

Status: proposed

[English](2026-08-24-multi-tenant-isolation.md) | 中文

## Problem

DeepSeek Harness 目前是单租户的。一个启动的进程把所有持久化事实都从一个 harness home（`resolveDshHome`/`dshHomePath`）解析：`settings.yaml`、`.credentials.yaml`、`.anonymous-user-id`、`skills/`、`AGENTS.md`、会话日志（`dshHomePath('sessions')`）和存储域（`dshHomePath('storages')`）。三套线上表面——stdio JSON-RPC 运行时（`packages/sdk`）、ACP stdio 服务和 HTTP API（`host/webserver` + `host/apiproxy` + `client/connection`）——每个进程绑定一份 `cwd`/凭证集，且不带任何客户端认证；唯一的「类认证」代码是 DNS 重绑定信任围栏，其注释明确写着「并非认证」。会话 id 是每进程一个命名空间；`session.list`/`search` 和 `sessionLog` 只按原始 id 解析，没有任何归属过滤。

企业级部署需要在一个无状态 API 后面服务多个租户，对会话、记忆、工具、技能做**严格**隔离，并且把每个租户的工具调用跑在该租户自己的容器里、只挂载该租户的工作空间和工具。目标形态是：agent 功能变成无状态中间件、状态外置到共享存储，前面是 HTTP API，工具调用按租户容器隔离。

## Proposal

新增 `packages/tenant/` 分组，在既有内核之上叠加多租户能力，而不改动单租户主干。隔离是「新 provider + 请求作用域租户权威」的性质，而不是对 core 会话/持久化接缝的改动。下文描述的纵向切片已经交付；已构建内容与暂缓内容记录在[实现笔记](../../implemented/architecture/2026-08-24-multi-tenant-slice.md)中。

### 租户身份与请求作用域权威

`@deepseek-ai/dsh-tenant` 拥有身份词汇与权威。`TenantId` 是 `Branded<'TenantId'>` id；`Tenant` 是认证请求所充当的、已解析的记录：

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

`TenantContext` 是基于 `AsyncLocalStorage` 的库原语（`dsh-scope` 模式）：`runWith(tenant, fn)` 为一次请求的同步/异步树进入租户，`current()` 返回 `Tenant | undefined`，`require()` 返回租户或在无租户时抛 `NO_TENANT_IN_SCOPE`。`TenantRegistry`（`ctx.tenants`）保存部署的租户记录，把认证后的 id 解析成存活的 `Tenant`，缺如或已禁用的租户一律失败关闭。

请求作用域上下文是**打开**类操作的权威——`SessionPersistence.load/inspect/list`、存储域打开、容器获取。而会话持久绑定（见下）是**异步 flush** 类操作（晚于请求 fiber 结束）的权威。

### 包拓扑

| 包 | 路径 | 表面 | 职责 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-tenant` | `tenant/` | `ctx.tenants`, `ctx.tenantContext` | 身份、记录、请求作用域权威 |
| `@deepseek-ai/dsh-tenant-auth` | `tenant-auth/` | `ctx.tenantAuth` | 认证 Service Definition |
| `@deepseek-ai/dsh-tenant-auth-jwt` | `tenant-auth-jwt/` | 注册一个 provider | JWT/OIDC 校验 → 租户 id |
| `@deepseek-ai/dsh-session-persistence-postgres` | `session-persistence-postgres/` | `ctx.sessionPersistence` | 租户键控的 Postgres 会话日志 |
| `@deepseek-ai/dsh-storage-postgres` | `storage-postgres/` | 注册后端 `postgres` | 租户键控的 KV 存储 hub 后端 |
| `@deepseek-ai/dsh-container` | `container/` | `ctx.containerRuntime` | 容器 owner Service Definition |
| `@deepseek-ai/dsh-container-docker` | `container-docker/` | 注册一个 provider | Docker/Podman 引擎生命周期 |
| `@deepseek-ai/dsh-fs-container` | `fs-container/` | `ctx.fs` | 走租户容器的 `FileSystem` |
| `@deepseek-ai/dsh-subprocess-container` | `subprocess-container/` | `ctx.subprocess` | 走租户容器的 `SubprocessRuntime` |
| `@deepseek-ai/dsh-api-http` | `api-http/` | HTTP 路由 | 无状态 HTTP API + 认证中间件 |
| `@deepseek-ai/dsh-tenant-demo` | `examples/tenant-demo/` | bin | 免密钥端到端装配 |

`storage-domain`（既有）原样复用：其 `routes`/`backend` 配置把 `workspace`、`session_projcache`、`message-feedback` 以及任何租户记忆域都指向 `postgres` 后端。

### 严格隔离不变量

隔离不变量在两点上强制执行且两点必须一致：

1. **环境权威**——`ctx.tenantContext.require()` 为每个打开类操作提供租户。它只来自认证（`ctx.tenantAuth`），绝不来自客户端输入、URL 段或会话 id。
2. **持久绑定**——Postgres provider 在每一行写入 `tenant_id`，并且每条语句都用它限定范围。每个租户还拥有自己的 schema（见下），所以即便漏掉某个 `tenant_id` 谓词也读不到别的租户的元组。

两点可见时必须一致：某次加载出的会话行若 `tenant_id` 与环境租户不同，就是失败的不变量，按隔离违规上报，绝不静默提供。跨租户访问无法表达，因为要访问租户 B 的元组就必须持有租户 B 的环境权威，而只有 `ctx.tenantAuth` 能凭合法 JWT 铸出该权威。

### 无状态中间件与 Postgres 状态

会话与记忆放在 Postgres 里，因此 API 副本可互换。Postgres 会话后端实现 `SessionPersistence` 接缝并按键控租户：每租户一个 schema（由租户 id 派生的、消毒后的 schema 名）、`tenant_id` 列，并且在 `create`/`load` 时由每个会话控制器捕获租户，使请求 fiber 结束之后的异步 flush（`session/flush`）仍写入正确租户。`list()` 按环境租户过滤。存储后端是对同一租户 schema 的同类 `KvFacet` 实现；设置与凭证文件放在 `Tenant.dataRoot` 下。

零 core 改动：`SessionHeader`、`SESSION_FORMAT_VERSION`、JSONL/SQLite 后端都不动。单租户装配继续原样工作。

### 容器隔离执行世界

可移植执行世界契约（`ctx.fs` + `ctx.subprocess` = 一个世界）把容器替换变成三个包，仿照 E2B POC：

- `@deepseek-ai/dsh-container` —— owner 接缝（`ctx.containerRuntime`）：`acquire(tenant)` 返回存活的 `ContainerHandle`（id、引擎句柄、`exec`），一个租户在其工具调用间复用一个容器，配空闲超时销毁。
- `@deepseek-ai/dsh-container-docker` —— 通过 Docker Engine API 创建/销毁容器。每个容器把 `Tenant.workspaceRoot` bind-mount 为 `/workspace`（读写）、`Tenant.toolsRoot` 为 `/tools`（只读），并按 `Tenant.network` 出站策略启动。
- `@deepseek-ai/dsh-fs-container` + `@deepseek-ai/dsh-subprocess-container` —— 两个执行世界 provider。`fs-container` 把面向 agent 的主机路径映射进 `/workspace`/`/tools` 并拒绝任何越界路径（容器边界）；`subprocess-container` 通过 owner 的 `exec` 在容器内运行 `argv` 并重映射 `cwd`。

容器世界里不用 `ctx.sandbox`/`ctx.sandboxPolicy`——容器本身就是边界。用容器对替换掉 `fs-local`/`subprocess-local`，就把 Bash、PTY、LSP、终端消费者一起搬进租户容器，消费者代码零改动；`ctx.codeRuntime` 仍是独立接缝。

### HTTP API 与认证

后端复用 JSON-RPC/会话词汇，但跑在 HTTP 载体上：一个 `node:http` 服务暴露 `session/prompt`（请求）与流式 `session.event` 下行（SSE 帧），外加租户/会话列表方法。Bearer token 中间件（`ctx.tenantAuth`）校验 JWT，经 `ctx.tenants` 解析租户，进入 `ctx.tenantContext.runWith(tenant, …)`，然后在该权威内创建或恢复 agent。没有任何请求字段直接指定租户；token 是唯一租户来源。

### 端到端数据流

`HTTP 请求 (Authorization: Bearer) → ctx.tenantAuth.authenticate → TenantId → ctx.tenants.resolve → ctx.tenantContext.runWith → agent 创建/恢复（Postgres，租户 schema）→ turn → 工具调用 → ctx.shell/ctx.fs → 容器 fs/subprocess provider（挂载 /workspace + /tools）→ 持久会话事件（Postgres）→ SSE 回客户端`。

## Alternatives considered

- **给 `SessionHeader` 加 `tenantId` 并贯穿 core** —— 真实的持久审计，但这是接近 `SESSION_FORMAT_VERSION` 级别的改动，会触及 `core/session` 校验、JSONL 头行、SQLite 列、投影缓存 checkpoint 身份与每个后端。把绑定叠进租户作用域 provider 能用零 core 改动达到同样隔离；`tenant_id` 列就是持久审计。暂否；若出现跨后端租户审计需求再议。
- **复用 `host/webserver` + `host/apiproxy` + `client/connection`** —— 最丰富的 HTTP 表面且已传输无关，但它带着浏览器全家（WebSocket 下行、`PRIVILEGED_METHODS` 回环门控、DNS 重绑定信任），而程序化企业 API 不需要、且其信任模型必须整体替换。一个更小的专用 HTTP 后端让认证边界更显式、更可测。首轮否；ApiProxy 复用接缝留给后续对齐阶段。
- **单共享 Postgres 库只用 `tenant_id` 列** —— 最省，但漏掉一个谓词就是跨租户泄漏。每租户 schema 让边界结构性成立；schema 是「每租户独立库」之上的折中，后者会让连接状态倍增。选定：每租户 schema + `tenant_id` 列做纵深防御。
- **E2B / Firecracker / 同内核 `ctx.sandbox`** —— E2B 是托管且临时；Firecracker 基础设施更重；`ctx.sandbox` 同内核、给不了每租户挂载边界。本地 Docker/Podman 契合企业私有化，且直接给出 bind-mount 模型。按运营方决策选定。
- **每次工具调用一个容器** —— 短命隔离最强，但每次调用都付镜像/启动延迟，且失去运营方描述的「挂载工作空间持久化」。「每租户一个持久容器（空闲销毁）」既满足需求，也正是「每个容器挂载该租户工作空间与工具」所要求的。

## Acceptance criteria

- `packages/tenant/` 分组及上述各包存在；`packages/README.md` 与分组 README 负责 ctx-key 映射。
- `dsh-tenant` 交付 `TenantId`、`TenantContext`（`runWith`/`current`/`require`）与 `TenantRegistry`，测试证明 `require()` 在 `runWith` 之外失败关闭。
- 免密钥 `tenant-demo` 启动一个装配：任意 bearer token（开发 JWT）解析出一个租户，一次 prompt turn 把持久会话事件写进该租户的 Postgres schema，一次 `bash`/`fs` 工具调用在该租户 Docker 容器内执行并挂载 `/workspace`+`/tools`。
- 严格隔离测试证明：租户 A 的会话 id 对租户 B 不可见；`list()` 只返回环境租户的会话；容器无法寻址 `/workspace`/`/tools` 之外的路径；未认证或跨租户请求被认证中间件拒绝。
- Postgres 与容器 provider 在后端不可达时大声失败（绝不回落主机文件系统/进程）。

## Risks

- **异步 flush 晚于请求** —— `session/flush` 可能在 `runWith` 结束后运行；缓解（在 `create`/`load` 时按会话控制器捕获租户）必须由一个「append 后解析请求，再强制 flush 并断言写入正确租户 schema」的测试证明。
- **Docker daemon 耦合与路径映射** —— 主机↔容器路径映射和 bind-mount 语义是细微逃逸所在；`fs-container` 拒绝两挂载之外的一切路径，验收测试通过执行器驱动拒绝，而非仅通过映射辅助函数。
- **每租户 schema 生命周期** —— 开通/注销时创建/删除租户 schema 是新的运维面；切片把「首次写入即建 schema」保留，并文档化运维契约。
- **范围** —— 十包加一个 demo 是多轮工程；纵向切片是完备线，广度（所有存储域、容器上的 terminal、`code-runtime` 容器 provider、ACP 对齐）是显式的后续项。