# Agent Note: 多租户隔离纵向切片

Status: implemented

[English](2026-08-24-multi-tenant-slice.md) | 中文

## 问题

DeepSeek Harness 目前是单租户的：一个启动的进程从一个 harness home 解析所有持久事实，stdio/ACP/HTTP 三个表面都不带客户端认证，因此会话、存储与文件都按裸 id 寻址、没有任何所有权过滤。企业部署需要在同一个无状态 API 后面服务多个租户，对会话与内存做严格隔离，并把每个租户的工具调用放进该租户自己的容器里。完整设计——动机、各包理由、被否掉的备选、以及切片之外的广度——见[提案笔记](../../proposed/architecture/2026-08-24-multi-tenant-isolation.md)。本笔记记录实际交付的纵向切片：第一批交付端到端地证明了隔离不变量。

## 决定

交付 `packages/tenant/` 作为无密钥（keyless）端到端切片：Bearer-JWT 认证、租户解析、Postgres 中的租户作用域会话、租户作用域的容器工具执行，全部叠在既有 capability 接缝上，对单租户 core 零改动。

### 已交付的包

| 包 | 路径 | ctx key | 职责 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-tenant` | `tenant/` | `ctx.tenants` | `TenantId`/`UserId`/`Tenant`/`TenantError`、`runWithTenant`/`requireTenant`/`currentTenant`、`runWithUser`/`requireUser`/`currentUser`、`tenantPartitionName`、`isTenantMember`、`TenantRegistry`（`resolve`/`resolveMember`） |
| `@deepseek-ai/dsh-tenant-auth` | `tenant-auth/` | `ctx.tenantAuth` | `TenantAuthenticator` Service Definition |
| `@deepseek-ai/dsh-tenant-auth-jwt` | `tenant-auth-jwt/` | 注册一个 provider | JWT（HS256/RS256）校验 → 租户 id |
| `@deepseek-ai/dsh-session-persistence-postgres` | `session-persistence-postgres/` | `ctx.sessionPersistence` | 租户键控的 Postgres 会话日志 |
| `@deepseek-ai/dsh-storage-postgres` | `storage-postgres/` | 注册后端 `postgres` | 租户键控的 KV 存储后端 |
| `@deepseek-ai/dsh-container` | `container/` | `ctx.containerRuntime` | 容器 owner Service Definition |
| `@deepseek-ai/dsh-container-docker` | `container-docker/` | 注册一个 provider | Docker/Podman 引擎生命周期 |
| `@deepseek-ai/dsh-fs-container` | `fs-container/` | `ctx.fs` | 走租户容器的 `FileSystem` |
| `@deepseek-ai/dsh-subprocess-container` | `subprocess-container/` | `ctx.subprocess` | 走租户容器的 `SubprocessRuntime` |
| `@deepseek-ai/dsh-api-http` | `api-http/` | `ctx.tenantHttpApi` | 无状态 HTTP API + 认证中间件 |
| `@deepseek-ai/dsh-tenant-demo` | `tenant-demo/` | — | 无密钥端到端装配 + 隔离测试 |

### 相对提案的偏差（按实交付）

- **租户权威是 `dsh-tenant` 的模块级导出，不是一个 `ctx.tenantContext` 服务。**`runWithTenant(tenant, fn)`、`requireTenant()`、`currentTenant()` 是基于 `AsyncLocalStorage` 的导出；`requireTenant()` 在作用域外抛出 `TenantError` `NO_TENANT_IN_SCOPE`。`TenantRegistry` 是 `ctx.tenants` 服务。
- **`ctx.containerRuntime` 是 `exec` 表面，不是 `acquire`/`handle`。**`ContainerRuntime.exec(command, args, opts)` 返回 `{ exitCode, stdout, stderr }`。`DockerContainerRuntime` 按租户分区惰性启动一个 `docker run -d … tail -f /dev/null` 容器（工作空间绑定挂载到 `/workspace`，可选工具挂载到 `/tools` 只读），每次调用走 `docker exec -i`，dispose 时 `docker rm -f`。空闲超时销毁暂缓。
- **HTTP 表面是单个已注册 operation 槽位，不是 JSON-RPC + SSE。**`TenantHttpApi` 暴露一条精确路由（默认 `/v1/run`）：非 POST → 405，认证 → 解析租户 → `runWithTenant` → 已注册 operation → JSON。错误映射为 401（`WWW-Authenticate: Bearer`）、403、上游状态码或 500。JSON-RPC/`session` 载体与 SSE 下行暂缓。
- **demo 在 `packages/tenant/tenant-demo/`，不在 `examples/tenant-demo/`，且跑的是直接 operation，不是 LLM prompt 回合。**`assembleDemo` 装配上述 provider；`makeDemoOperation` 执行一次容器工具调用（`mkdir`/`printf` 一个标记、再在世界内读回），向租户 schema 追加一条 `todo/write` 会话事件，并返回租户作用域结果。

### 隔离不变量

隔离在两点上强制执行且必须一致，同设计：

1. **环境权威** — `requireTenant()` 是开放操作的唯一租户来源；它只来自 `ctx.tenantAuth`，绝不来 URL 段、会话 id 或请求体。
2. **持久绑定** — Postgres 后端在每行写入 `tenant_id`、每条语句按其过滤，并让每个租户拥有自己的 schema（`tenantPartitionName`）。每租户一个 schema，使漏掉谓词仍无法读到另一租户的元组。

比请求 fiber 存活更久的异步 flush，由 `create`/`load` 时捕获的 per-session-controller 绑定 Map 覆盖，因此迟到的 `session/flush` 写入打开该会话的租户，而非环境作用域。

## 备选方案考虑

完整集合及各自落败的理由见提案笔记。本切片敲定的决策：

- **在租户作用域 provider 上叠加 vs. 把 `tenantId` 贯穿进 core `SessionHeader`** — 叠加用零 core 改动换来同样的隔离；`tenant_id` 列是持久审计。选择：叠加。
- **每租户 schema + `tenant_id` vs. 仅 `tenant_id` 或每租户一个库** — 每租户 schema 让边界结构化；列是纵深防御。选择：schema + 列。
- **本地 Docker/Podman 绑定挂载 vs. E2B/Firecracker/`ctx.sandbox`** — Docker 契合本地部署并直接给绑定挂载模型。选择：Docker/Podman。
- **专用单槽位 HTTP 后端 vs. 复用 `host/webserver`+`host/apiproxy`** — ApiProxy 带着必须整体替换的浏览器花名册信任；小后端让认证边界显式可测。选择：专用后端，ApiProxy 复用留待对齐阶段。

## 后果

**得到：**一个可运行的证明——同一进程服务两个租户，各用独立容器、独立宿主机工作空间、独立 Postgres schema、共享会话 id 互不可见，背后是一条无状态 Bearer 认证路由；单租户 core、E2B 式的可移植执行世界替换、以及既有后端均未改动。

**代价与暂缓：**demo 不驱动 LLM 回合；HTTP 载体是单个 operation，不是带 SSE 下行的 JSON-RPC/`session` 词汇表；容器空闲超时销毁、`dataRoot` 下的全部存储域与凭据、terminal/LSP/`code-runtime` 容器 provider、以及 ACP 对齐，都是提案笔记中「作用域」风险里记录的显式后续工作。

### 验证

`pnpm exec tsc -b tsconfig.host.json` 与 `pnpm run typecheck` 通过（host 与 client 两面）。11 个包的 54 条单元测试通过。`tenant-demo` 的端到端套件（无 `TEST_POSTGRES_URL` 与可达容器运行时时自跳过）于 2026-08-24 针对 PostgreSQL 16 与 Docker 实跑：`acme` 与 `globex` 请求返回各自的标记，宿主机工作空间物理分离，`sessionPersistence.list()` 各租户只看到自己的会话，为未注册租户铸造的凭据被以 `TENANT_UNKNOWN`（403）拒绝。
