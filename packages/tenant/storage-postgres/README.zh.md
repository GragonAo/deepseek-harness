# @deepseek-ai/dsh-storage-postgres

[English](README.md) | 中文

存储 hub 的 (租户, 用户) 键控 PostgreSQL 后端。它提供 `kv` facet 并注册为后端 `postgres`；每个按用户单位操作解析环境租户与用户，并指向该租户的私有 schema 加主键内嵌的 `user_id`，因此漏掉的谓词在结构上也无法寻址另一租户或另一用户的元组。案件共享单位（`shared: true`）只按租户存储，无 `user_id`。

## 隔离模型

- **每租户一个 schema。** schema 名是 `tenantPartitionName(id)` —— 消毒后的租户 id 前缀加 12 位十六进制哈希后缀，始终是安全的 PostgreSQL 标识符且 ≤63 字符。
- **每条记录一个用户行。** `kv_record` 以 `(unit, user_id, table_name, key)` 为键，`kv_global` 以 `(unit, user_id)` 为键，因此同一租户的两个用户在同一 schema 中各持独立的记录。
- **案件共享单位（`shared: true`）只按租户存储。** `KvUnitDescriptor.shared`（默认按用户）让单位的记录与全局槽不带按用户的 `user_id`，写入 `kv_case_record`（主键 `(unit, table_name, key)`）与 `kv_case_global`（主键 `(unit)`），于是该租户的每个主体都读写同一份案件级记忆。这种单位只解析 `requireTenant()`，其双重打开守卫键是 `${schema}.${name}` 而非 `${schema}.${user}.${name}`。
- **逐操作目标绑定，而非逐次打开。** `ctx.storageDomain` 每个单位每个进程按 (租户, 用户) 只打开一次，因此后端在每次 `loadAll`/`putRecord`/`deleteRecord`/`setGlobal` 开始时解析 `requireTenant()` 与 `requireUser()`，并在整个调用中携带捕获的作用域。在认证请求之外，操作以 `NO_TENANT_IN_SCOPE`（或租户无用户时的 `NO_USER_IN_SCOPE`）失败关闭。
- **版本盖章按租户进行。** 每个租户的 schema 在首次使用时盖自己的 `kv_meta.version`；不匹配时以 `version-mismatch` 拒绝。

每个租户 schema 有五张表：`kv_meta`（单位版本，在租户内共享）、`kv_record`（每个 `(unit, user_id, table, key)` 一条 `jsonb` 记录）、`kv_global`（每个 `(unit, user_id)` 一个值）、`kv_case_record`（每个 `(unit, table, key)` 一条 `jsonb` 记录，无 `user_id`，供案件共享单位用）、`kv_case_global`（每个 `(unit)` 一个值，供案件共享单位用）。

## 配置

```yaml
- name: '@deepseek-ai/dsh-storage-postgres'
  config:
    connectionString: 'postgres://dsh:dsh@localhost:5432/dsh'
```

角色必须在目标数据库持有 `CREATE`：每个租户的首次写入会创建其自己的 schema。

## 模型体验

### 租户与用户键控持久化

#### 模型看到什么

无。此后端以 `postgres` 后端身份服务模型之下的存储 hub：没有工具、提示词或会话事件。

#### Token 影响

每个请求零直接 token。

#### KV Cache 影响

与在线请求无关：本包从不触碰请求前缀。

## 已知限制与延期工作

- **单进程版本盖章。** `ensured` 记忆是宿主本地的、非事务的；对于水平扩展的进程，`kv_meta` 版本盖章没有并发守护。
- **只支持环境作用域写入。** 其写入活过请求 `runWithTenant`+`runWithUser` 作用域（例如异步投影缓存 flush）的域，不受读取环境作用域的解析器支持；此类域不在纵向切片范围内。
- **没有连接活跃性探针。** 失效连接池表现为查询错误而非加载时检测；重连行为留给 `pg`。
