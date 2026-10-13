# @deepseek-ai/dsh-tenant-admin

带作用域鉴权的租户管理服务（`ctx.tenantAdmin`）。它持有 [`@deepseek-ai/dsh-tenant-admin-http`](../tenant-admin-http) 在 `/admin` 提供的管理面背后的操作：租户增删改查、启用/停用、成员准入、用户层目录引导，以及保证每个租户的数据与宿主机目录相互隔离的分区/目录生命周期。

## 接口面

除非环境 JWT 的 scopes 携带管理作用域（`adminScope`，默认 `dsh:tenant-admin`），否则每个方法都以 `tenant-forbidden` 拒绝。管理载体在调用方法前进入已认证主体的 scopes，本服务再校验同一作用域，因此调用方无法绕过载体的检查来触达方法。下表中的名称就是载体的线协议方法名；服务自身的成员是同一批操作去掉域前缀。

| 线协议方法 | 作用 |
| --- | --- |
| `tenants.list` / `tenants.get` | 列出或查询一条记录，包括已停用的租户。 |
| `tenants.create` | 预置分区、宿主机目录、注册表条目与持久化记录。 |
| `tenants.update` | 修改 `name`、`workspaceRoot`、`toolsRoot` 或 `network`（`id`/`dataRoot` 不可变）。 |
| `tenants.enable` / `tenants.disable` | 在载体处切换请求准入。 |
| `tenants.remove` | 删除记录；`purge: true` 同时删除分区并归档目录。 |
| `members.list` / `members.add` / `members.remove` | 准入或移除一个主体；`add` 会引导该主体的案件工作区目录与用户层目录。 |
| `users.ensure` | 预创建某主体的 `usersRoot/<sub>/{config,skills,tools}` 目录树。 |

## 隔离与生命周期

- **创建时建分区。** schema 生命周期接缝会创建租户分区（Postgres 下为 `tenantPartitionName(id)`），使新租户的提供方不与其它租户共享存储。
- **创建时建目录。** `bootstrapTenantDirs` 创建 `dataRoot`、案件共享层 `workspaceRoot/shared/{config,skills,tools}`，以及每个已准入成员的 `workspaceRoot/users/<sub>` 与 `usersRoot/<sub>/{config,skills,tools}`。这些路径都是该主体沙箱的绑定挂载源，因此由预置流程创建，而不是留给容器运行时在挂载点建一个空目录。
- **归档而绝不删除。** `remove(id, purge: true)` 先删除分区，再把 `dataRoot` 与 `workspaceRoot` 移入 `archiveRoot/<id>-<timestamp>/`。purge 是归档而非删除宿主机数据。
- **跨文件系统归档靠复制。** 容器化部署里归档根与租户的各个根是两个独立的绑定挂载源，因此 `rename` 会报 `EXDEV`，移动退化为递归复制再删除源目录。文件权限与时间戳得以保留，符号链接按原样复制，因此目录树内的相对链接在归档位置仍然可解析。只有「目录本就不存在」会被跳过：其余任何归档失败都会让 `remove` 调用失败，而不是返回 `{ removed: true }`。
- **用户即 JWT 主体。** 没有用户表：准入是每个租户的 `members` 列表，主体是任何 token `sub` 能解析出来的人。`usersEnsure` 在首次使用前物化用户层目录。

## 持久化

两个可选接缝为管理面提供持久化；部署挂载 `@deepseek-ai/dsh-tenant-admin-postgres`（或其它提供方）来满足它们。服务按 key 读取（`ctx.get`），因此测试装配可以纯内存运行。

- `tenantRecordStore`（`load`/`upsert`/`delete`）—— 持久化的租户列表。水合在 `tenantRecordStore` 这个服务 key 出现时执行：组合不保证行的先后，晚挂载的提供方也会把记录读进来。store 记录覆盖同 id 的 config 种子。
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

### Administrative surface, not model input

#### What the model sees

无。该服务位于面向运维的 `/admin` 管理面之后；不新增任何工具、提示词或会话事件。

#### Token effect

每次请求零 Token。

#### KV Cache effect

与模型请求前缀无关。

## Known Limitations and Deferred Work

- **没有凭据或用户管理。** 主体是 JWT 的 `sub` 值；管理面只能把主体加入或移出某个租户的 `members`，不签发任何凭据。
- **仅删记录会留下孤儿。** 不带 `purge` 的 `remove` 只删记录，分区与宿主机目录仍在；运维需自行重建或 purge。
- **purge 非事务化。** 分区删除先于目录归档，因此任一步骤失败都会留下一个仍注册的租户：它的分区可能已被删除，而目录还在宿主机上。
