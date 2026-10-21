# @deepseek-ai/dsh-session-persistence-postgres

`SessionPersistence` seam 的 (租户, 用户) 键控 PostgreSQL provider。逻辑会话不变；物理后端把每个会话的不可变 header 存于 `session_meta`、把其事件溯源日志作为整行 JSON 存于 `session_event`，二者都在每租户私有的 schema 内，且每行携带 `user_id` 列，使一个已认证主体的日志与另一个主体的日志彼此分开。

## 隔离模型

- **每租户一个 schema。** schema 名是 `tenantPartitionName(id)`，消毒后的租户 id 前缀加哈希后缀（≤63 字符，安全的 PostgreSQL 标识符）。请求只能寻址其认证所属的租户。
- **每行一个 `user_id` 列。** `session_meta` 与 `session_event` 在每个会话 id 旁一并携带归属用户的 id，因此同一租户的两个用户在同一 schema 中各持独立的行。
- **读解析环境租户与用户。** `loadStored`/`readStoredRevision`/`loadStoredFrom` 在调用入口读取 `requireTenant()` 与 `requireUser()`，并以 `WHERE id = $1 AND user_id = $2` 查询，因此跨租户或跨用户会话 id 在构造上不可寻址 —— 它只会解析为「不存在」（`undefined`）。`list`/`listSnapshots` 只返回环境用户的会话，任何作用域之外为空。
- **写按归属 (租户, 用户) 绑定。** store 在物化时（首次 `appendBatch`）及任何成功读取时捕获 (租户, 用户)，之后重用该绑定处理可能活过请求 `runWithTenant`+`runWithUser` 作用域的迟到异步 flush。对本进程从未物化的会话做请求作用域修复时回退到环境作用域。删除同样按该绑定定位行：`delete(id)` 解析归属作用域后，在单个事务中以 `WHERE id = $1 AND user_id = $2` 删除 `session_event` 与 `session_meta` 行，然后释放该 id 的绑定。绑定存在时，未认证作用域的删除也会落在该 id 的归属 schema 与用户上，与 append 的规则一致；绑定不存在时则需要环境租户与用户。
- **检查持久一致性。** `session_meta.tenant_id` 与每个 header 一并存储；加载时拒绝任何 `tenant_id` 与环境租户不一致的行。

`appendBatch`/`commitRepair` 在单个事务中运行，因此不存在撕裂尾部，`tornMarker` 从不发出。删除也在单个事务中运行，因此一个会话的行集合要么全部消失、要么全部保留；删除后 PostgreSQL 不会把已释放的页面归还操作系统，回收空间需要带外 `VACUUM`。

## 配置

```yaml
- name: '@deepseek-ai/dsh-session-persistence-postgres'
  config:
    connectionString: 'postgres://dsh:dsh@localhost:5432/dsh'
```

角色必须在目标数据库持有 `CREATE`：每个租户的首次写入会创建其自己的 schema。

## Model Experience

### Tenant- and user-keyed session persistence

#### What the model sees

无。provider 服务模型之下的 `ctx.sessionPersistence` 会话存储：没有工具、提示词或会话事件。

#### Token effect

每个请求零直接 token。

#### KV Cache effect

与在线请求无关：本包从不触碰请求前缀。

## Known Limitations and Deferred Work

- **服务器重启后不保留每会话 (租户, 用户) 权威。** 归属绑定是宿主本地的；恢复的会话由其在（已认证）租户与用户下的下一次成功读取重新绑定。
- **除 coordinator 的校验外没有 header 版本分歧策略。** store 原样持久化 `version` 并让 `PersistenceCoordinator` 拒绝不支持的版本。
- **没有连接活跃性探针。** 失效连接池表现为查询错误；重连行为留给 `pg`。
