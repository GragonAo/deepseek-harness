# @deepseek-ai/dsh-tenant-admin

[English](README.md) | 中文

带作用域鉴权的租户管理服务（`ctx.tenantAdmin`）。它是 `tenant.admin.*` API 面背后的实现：租户增删改查、启用/停用、成员准入、用户层目录引导，以及保证每个租户的数据与宿主机目录相互隔离的分区/目录生命周期。

## 接口面

除非环境 JWT 的 scopes 携带管理作用域（`adminScope`，默认 `dsh:tenant-admin`），否则每个方法都以 `tenant-forbidden` 拒绝。

| 方法 | 作用 |
| --- | --- |
| `tenant.admin.list` / `.get` | 列出或查询一条记录，包括已停用的租户。 |
| `tenant.admin.create` | 预置分区、宿主机目录、注册表条目与持久化记录。 |
| `tenant.admin.update` | 修改 `name`、`workspaceRoot`、`toolsRoot` 或 `network`（`id`/`dataRoot` 不可变）。 |
| `tenant.admin.enable` / `.disable` | 在载体处切换请求准入。 |
| `tenant.admin.remove` | 删除记录；`purge: true` 同时删除分区并归档目录。 |
| `tenant.admin.members.list` / `.add` / `.remove` | 准入或移除一个主体；`add` 会引导该主体的用户层目录。 |
| `tenant.admin.users.ensure` | 预创建某主体的 `usersRoot/<sub>/{config,skills,tools}` 目录树。 |

## 隔离与生命周期

- **创建时建分区。** schema 生命周期接缝会创建租户分区（Postgres 下为 `tenantPartitionName(id)`），使新租户的提供方不与其它租户共享存储。
- **创建时建目录。** `bootstrapTenantDirs` 创建 `dataRoot`、`workspaceRoot/shared`（含 `tools`/`skills`）以及每个已准入成员的宿主机目录。
- **归档而绝不删除。** `remove(id, purge: true)` 先把 `dataRoot` 与 `workspaceRoot` 移入 `archiveRoot/<id>-<timestamp>/`，再删除分区。purge 是归档而非删除宿主机数据。
- **用户即 JWT 主体。** 没有用户表：准入是每个租户的 `members` 列表，主体是任何 token `sub` 能解析出来的人。`usersEnsure` 在首次使用前物化用户层目录。

## 持久化

两个可选接缝为管理面提供持久化；部署挂载 `@deepseek-ai/dsh-tenant-admin-postgres`（或其它提供方）来满足它们。服务按 key 读取（`ctx.get`），因此测试装配可以纯内存运行。

- `tenantRecordStore`（`load`/`upsert`/`delete`）—— 持久化的租户列表。启动时用它水合在线注册表；store 记录覆盖同 id 的 config 种子。
- `tenantSchemaLifecycle`（`provision`/`purge`）—— 每个租户的存储分区。

## 配置

```yaml
- name: '@deepseek-ai/dsh-tenant-admin'
  config:
    adminScope: dsh:tenant-admin
    usersRoot: /opt/dsh/users
    archiveRoot: /opt/dsh/archive
```

## Model Experience

### 管理面，非模型输入

#### 模型可见内容

无。该服务位于面向运维的 `tenant.admin.*` 之后；不新增任何工具、提示词或会话事件。

#### Token 影响

每次请求零 Token。

#### KV Cache 影响

与模型请求前缀无关。

## 已知限制与待办

- **没有凭据或用户管理。** 主体是 JWT 的 `sub` 值；管理面只能把主体加入或移出某个租户的 `members`，不签发任何凭据。
- **仅删记录会留下孤儿。** 不带 `purge` 的 `remove` 只删记录，分区与宿主机目录仍在；运维需自行重建或 purge。
- **purge 非事务化。** 目录归档先于分区删除，若中间失败会留下已归档的目录树与仍存在的分区。
