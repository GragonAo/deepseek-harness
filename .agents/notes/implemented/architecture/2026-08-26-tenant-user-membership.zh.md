# Agent Note：租户用户身份与成员资格权威

Status: implemented

[English](2026-08-26-tenant-user-membership.md) | 中文

## 问题

多租户切片（[2026-08-24](2026-08-24-multi-tenant-slice.md)）把租户定为隔离单元，却未使用已认证主体：`tenant-auth-jwt` 把 JWT `sub` 放进 principal，但认证之后没有任何地方读取 `subject` 做授权。因此每个租户都是一个共享世界——被接纳进某租户的所有主体都在同一工作目录、同一存储 schema、同一容器里行动——于是有多个协作者的租户无法把各用户会话、记忆与文件分开，租户也无法只接纳部分已认证主体。

跨盒身份是 JWT `sub`（一个 OIDC 主体）。「案件」已并入租户（单一概念，不设独立案件层）；用户即跨盒主体。因此按用户隔离就是 `(tenant, subject)` 这个二元组，作为叠在租户权威里的第二层请求作用域权威——不是一个案件实体，也不是新的分区名函数。

## 决策

扩展 `@deepseek-ai/dsh-tenant`，加入用户权威与每租户成员资格，并在载体中强制执行：

- `UserId`（`Branded<'UserId'>`）配 `UserId(id)` 工厂，以及 `Tenant.members?: readonly string[]`（被接纳的主体）。
- `runWithUser(user, fn)` / `currentUser()` / `requireUser()` —— 第二个模块 `AsyncLocalStorage`，叠加在 `runWithTenant` 之上。`requireUser()` 在无 run 环境外抛 `TenantError` `NO_USER_IN_SCOPE`。
- `isTenantMember(tenant, subject)` —— `members` 缺省或为空即开放；否则主体必须在列表中。
- `TenantRegistry.resolveMember(id, subject)` —— `resolve` 加成员资格门，抛 `TenantError` `NOT_A_MEMBER`；`Config.tenants` 新增 `members?: string[]` 线上字段，注册时透传给记录。
- `@deepseek-ai/dsh-agent-http` 经 `resolveMember(principal.tenantId, UserId(principal.subject))` 解析租户，并在委托前进入 `runWithTenant` + `runWithUser`，于是 `NOT_A_MEMBER` 与 `TENANT_UNKNOWN`/`TENANT_DISABLED` 一样返回 403，网关背后的用户作用域 provider 读 `requireUser()`。
- `@deepseek-ai/dsh-agent-http` 还把它暴露的跨会话通道限定到环境 `(tenant, user)`：一张活跃会话归属映射 `sessionScopes: Map<string, { tenant, user }>`（由 `session/created` 在 `currentTenant()` + `currentUser()` 下喂入，`session/disposed` 时释放）支撑 `owns(sessionId, tenantId, user)`，对冷会话（无活跃归属）或匹配的活跃归属返回真；`session.list`/`session.search` 的条目与 `events.mux`/`events.host` 的会话作用域帧都经它过滤。

按用户分区读取这条接缝：持久 `(tenant, user)` 键见 [2026-08-26](2026-08-26-per-user-storage-partition.md)，`@deepseek-ai/dsh-container-docker` 中的 `(tenant, subject)` 容器键与三层挂载，以及上文载体的会话到用户归属。

## 考虑过的替代方案

- **必填 `members`（`.min(1)`，失败响亮）** —— 否决：租户记录与 `enabled?`/`toolsRoot?` 可选宽松字段对称，必填列表会迫使每个非 carrier fixture 编造一个；部署本就显式设置 `members`。
- **空列表表示「对所有人关闭」** —— 否决：缺省与空列表的差异埋了 `members: []` 静默锁死所有人的坑；把两者都视为开放使门对称，并把「禁用所有人」留给 `enabled: false`。
- **在各按用户存储 provider 而非载体处把关成员资格** —— 否决：载体是唯一认证入口；在此强制执行一次（`resolveMember` 是载体唯一的 resolve 路径）是一个执行点，而非 N 个。

## 后果

- 请求作用域用户现在对 Postgres 会话、存储、设置与凭证 provider 可用，因此按用户分区只是加列/改主键，而非新增权威。
- 载体现在既鉴权又授权：非成员主体在任何方法运行前即被 `NOT_A_MEMBER`（403）拒绝。
- 运营方未设 `members` 的租户对任意已认证主体开放；生产会显式设置（已记入包 README）。

### 验证

- `packages/tenant/tenant/tests/tenant.spec.ts` 新增用户权威、`isTenantMember`、`resolveMember` 与 config `members` 透传用例；`packages/tenant/agent-http/tests/agent-http.spec.ts` 新增非成员 403，并钉住 `session.list`/`session.search` 条目与 `events.mux`/`events.host` 会话作用域帧的 `(tenant, user)` 限定。tenant 组 `tsc -b` 通过。
