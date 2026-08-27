# Agent Note：每个租户下按用户隔离存储

Status: implemented

[English](2026-08-26-per-user-storage-partition.md) | 中文

## 问题

多租户切片（[2026-08-24](2026-08-24-multi-tenant-slice.md)）把每项持久事实按租户隔离 —— 每租户一个 schema、每行一个 `tenant_id`、每租户一个容器 —— 用户身份与成员资格权威（[2026-08-26](2026-08-26-tenant-user-membership.md)）则把已认证主体放进请求作用域。但持久层仍只按租户键控，于是被接纳进同一租户的两个主体看到的是同一份 KV 存储、会话日志、设置文档、凭据映射与 workspace 注册表。按用户隔离要求分区在租户之外再携带 `user_id`，使主体只能寻址自己的记录。

## 决策

把隔离单元从 `tenant` 扩展到 `(tenant, user)`，覆盖各持久层与内存层，叠在 `runWithTenant` + `runWithUser` 之上：

- `@deepseek-ai/dsh-storage-postgres` 把 `kv_record` 键控为 `(unit, user_id, table_name, key)`、`kv_global` 键控为 `(unit, user_id)`；每次 `loadAll`/`putRecord`/`deleteRecord`/`setGlobal` 在调用入口解析 `requireTenant()` + `requireUser()`。`kv_meta` 保留其按单位版本盖章，在租户内共享（无 `user_id`）。
- `@deepseek-ai/dsh-session-persistence-postgres` 给 `session_meta` 与 `session_event` 加 `user_id` 列；按 id 读取以 `WHERE id = $1 AND user_id = $2` 过滤，因此属于同一租户另一用户的会话 id 解析为不存在。`list`/`listSnapshots` 只返回环境用户的会话，作用域之外为空。写入在物化时捕获归属 `(tenant, user)`，并复用于活过请求的 flush。
- `@deepseek-ai/dsh-settings` 在 `tenantScoped` 旁新增受保护的 `userScoped` getter（默认 `false`）；内存文档缓存按 `(tenant, user)` 作用域键 `tenant.id\0user` 键控，而非租户 id。`@deepseek-ai/dsh-settings-postgres` 设 `userScoped = true`，并按 `(tenant, user)` 存储其 `settings_doc` 单元。
- `@deepseek-ai/dsh-credentials-postgres` 按 `(tenant, user)` 存储其 `credentials_doc` 映射；`loadDoc` 在作用域之外返回空。
- `@deepseek-ai/dsh-storage-domain` 的 `partitionKey(name)`（单次打开守卫）在租户与用户同在作用域内时为 `${tenantPartitionName}.${userPartitionName}.${name}`，否则为裸名。
- `@deepseek-ai/dsh-workspace` 按 `(tenant, user)` 分区键控注册表分区状态，而非按租户。

跨用户 id 在构造上不可寻址并失败关闭：漏掉的 `user_id` 谓词、或为同一租户另一用户铸出的会话 id，都不会返回其他主体的行。

## 考虑过的替代方案

- **`user_id` 仅作查询级过滤，而非主键列** —— 否决：租户切片的不变量是漏掉谓词仍不能在结构上跨界；把 `user_id` 放进主键为用户维度保留该性质，因此漏掉过滤的缺陷仍不会返回跨用户行。
- **空字节 vs. 可打印作用域键分隔符** —— 设置作用域键用 `tenant.id\0user`，因为本代码库的品牌 id 不含 `\0`，复合键无法被伪造或碰撞；`/` 或 `.` 分隔符原则上可能出现在 id 中。分区名复合键（`${tenantPartitionName}.${userPartitionName}.${name}`）用 `.` 分隔，因为两个分区名本就是不含 `.` 的安全标识符。
- **在每租户缓存内嵌套按用户 map vs. 单一扁平复合键** —— 单个扁平键让文档缓存与按 namespace 写队列落在同一索引上，并与分层用户权威一致，而非 `Map<tenant, Map<user, doc>>` 形制的第二存储。

## 后果

所得：每个持久层与内存层现在都按 `(tenant, user)` 分区，因此同一租户的两个协作者各自拥有独立的 KV 记录、会话日志、设置、凭据、领域投影与 workspace 注册表；`kv_meta` 仍是租户持有的共享按单位盖章。跨用户读取失败关闭而非泄漏。

代价：按用户 provider 现在每次操作解析两重权威（`requireTenant()` + `requireUser()`），无用户的请求抛 `NO_USER_IN_SCOPE` 而非服务租户级数据；单用户路径仍回退到无作用域/`''` 键，行为不变。

### 验证

包测试套件钉住这不变量：`packages/tenant/storage-postgres/tests/backend.spec.ts`（同一租户的两个用户各持独立行；双重打开守卫按 `(tenant, user)` 键控）、`packages/tenant/session-persistence-postgres/tests/store.spec.ts`（跨用户会话 id 解析为 `undefined`；`list` 只返回环境用户的会话）、`packages/workspace/workspace/tests/workspace.spec.ts`（同一租户的两个用户各持独立注册表）。`credentials-postgres` 与 `settings-postgres` provider 套件经同一 helper 进入 `runWithTenant` + `runWithUser` 作用域。