# @deepseek-ai/dsh-tenant

[English](README.md) | 中文

多租户 DeepSeek Harness 部署的租户身份、请求作用域权威与注册表。此包不拥有持久状态、不注册工具；它是各多租户 provider 读取的边界。

## 形态

- `TenantId` —— 不透明的 `Branded<'TenantId'>` id，配 `TenantId(id)` 工厂；`UserId` —— 不透明的 `Branded<'UserId'>` 主体，配 `UserId(id)` 工厂。
- `Tenant` —— 认证请求所充当的已解析记录：`id`、`name`、`dataRoot`、`workspaceRoot`、可选 `toolsRoot`、可选 `enabled`、可选 `network` 出站策略，以及可选 `members`（被接纳的主体列表；缺省或为空表示对任意已认证主体开放）。
- `runWithTenant(tenant, fn)` / `currentTenant()` / `requireTenant()` —— 请求作用域租户权威；`runWithUser(user, fn)` / `currentUser()` / `requireUser()` 以同样方式携载认证主体。每项权威是一个模块级 `AsyncLocalStorage`（`withInitiator` 模式），因此每个租户或用户感知的 provider 读同一份存储。`requireTenant()` 在无 run 环境外抛 `TenantError` code `NO_TENANT_IN_SCOPE`，`requireUser()` 抛 `NO_USER_IN_SCOPE`。
- `isTenantMember(tenant, subject)` —— 主体是否被接纳进租户：`members` 缺省或为空即开放，否则主体必须在列表中。
- `tenantPartitionName(tenantId)` / `userPartitionName(user)` —— 确定性的存储分区名：消毒后的 id 前缀加抗碰撞哈希后缀，始终是安全的 PostgreSQL 标识符（≤63 字符）。租户名是 Postgres 后端所用的每租户 schema；用户名是持久 `user_id` 的安全 token 形式，供内存守卫键与容器名使用。
- `TenantRegistry`（`ctx.tenants`）—— 部署的租户记录：`register(tenant)` 返回精确 disposer、`get`、`resolve`（失败关闭地拒绝 `TENANT_UNKNOWN` / `TENANT_DISABLED`）、`resolveMember(id, subject)`（当租户列出的成员不包含该主体时追加 `NOT_A_MEMBER`）、`list`。租户也可经 cordis.yml 的 `Config.tenants` 声明（`{ id, name, dataRoot, workspaceRoot, toolsRoot?, enabled?, network?, members? }` 线上形态，其 `id` 在注册时被品牌铸造为 `TenantId`）；每条记录以 effect 挂载。

隔离叠在此处而非 core：多租户 provider 对每个打开类操作调用 `requireTenant()`，并强制执行它们自持的持久 `tenant_id`/schema 绑定，因此一个请求只能寻址其认证所铸出的那个租户。

## Model Experience

### 租户解析与注册表

#### 模型看到什么

无。`ctx.tenants` 与租户权威只服务 host 侧 provider：本包不注册工具、不注入提示、不写会话事件。

#### Token 影响

每次请求零直接 token。

#### KV Cache 影响

与活动请求无关：本包从不触碰请求前缀。

## Known Limitations and Deferred Work

- **租户记录在内存中** —— 开通即「装配中的注册」，不是持久存储；持久租户开通/注销（连同 schema 生命周期）延后到 Postgres provider 及其运维契约。
- **权威是进程本地的** —— `AsyncLocalStorage` 在单个 Node.js 进程内传播；跨副本转发在线上携带租户 id，并在接收侧用 `runWithTenant` 重新进入。