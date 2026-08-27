# Agent Note：案件共享 KV 单位

Status: implemented

[English](2026-08-26-case-shared-kv-units.md) | 中文

## 问题

按用户存储分区（[2026-08-26](2026-08-26-per-user-storage-partition.md)）把每条 KV 记录与全局槽都按 `(tenant, user)` 键控，于是同一租户的两个协作者各自只能读到自己的记忆。有些记忆是案件级而非用户级的：一个案件就是一个租户（[2026-08-26](2026-08-26-tenant-user-membership.md)），被接纳进该案件的每个主体都必须读写同一批记录——一案多会话共享案件级记忆。按用户单位无法承载这种记忆，因为每个用户的写入与读取都解析到自己的 `(unit, user_id, table_name, key)` 条带；持久层需要一条并排在按用户行旁的仅租户条带。

## 决策

给 `@deepseek-ai/dsh-storage` 的 `KvUnitDescriptor` 增加一个可选的 `shared?: boolean`（缺省即按用户）。当 `shared === true`：

- `@deepseek-ai/dsh-storage-postgres` 把该单位的记录存进 `kv_case_record`（主键 `(unit, table_name, key)`）、把它的全局槽存进 `kv_case_global`（主键 `(unit)`），两张表都在 `materialize()` 里与 `kv_record`/`kv_global` 一起创建。共享单位的 `loadAll`/`putRecord`/`deleteRecord`/`setGlobal` 只解析 `requireTenant()`，从不读取环境用户，因此仅租户作用域即可。
- 共享单位双重打开的守卫键是 `${tenantPartitionName(tenant.id)}.${name}` 而非 `${tenantPartitionName(tenant.id)}.${userPartitionName(user)}.${name}`：同一声明单位每租户打开一次，而非每 (tenant, user) 一次。
- `kv_meta` 版本盖章不变——每单位一枚盖章，在该租户的用户间共享。

共享表完全不携带 `user_id` 列，因此案件共享行在构造上无法按用户寻址：不存在可泄漏的用户维度。

## 考虑过的替代方案

- **在既有 `kv_record`/`kv_global` 表里放保留 `user_id`（`NULL`、`''` 或哨兵值）** —— 否决：那两张表之所以把 `user_id` 放进主键，正是为了让漏掉的谓词无法跨过用户边界；藏在哨兵后面的案件行会成为一个每个按用户查询都必须记得排除的魔法值，而 `NULL` 又不能进主键列。两张专用表让「共享」成为键上的差异，而非特殊值。
- **把描述符上的作用域定为枚举（`'case' | 'user'`）而非布尔标志** —— 否决：`shared?: boolean` 与描述符既有的可选 `hasGlobal` 对称，并按默认不写保留按用户默认；案件共享单位与按用户单位的差别只在 `user_id` 列是否参与，一个布尔值就能表达，无需引入第二种枚举。

## 后果

所得：案件的共享记忆与按用户记忆并存在同一租户 schema 中，因此案件的每个主体都读写同一份共享记录集与全局槽，同时各自的私有按用户行保持分离。案件共享仍受租户约束（schema 仍按租户划分），因此一个案件的共享记忆绝不会跨界到另一租户。

代价：案件共享的记录在案件诸主体之间是最后写入者胜出，没有按用户的审计记录指明是谁改了某共享行。该标志是描述符级的——`@deepseek-ai/dsh-storage-domain` 的 `descriptorOf` 不投影 `shared` 字段，所以 `DomainSpec` 目前无法声明案件共享单位，且只有多租户 Postgres 后端读取该标志。

### 验证

`packages/tenant/storage-postgres/tests/backend.spec.ts` 钉住这一行为：仅租户作用域下（无用户）写入的共享单位，其 SQL 指向 `kv_case_record`/`kv_case_global` 且不含 `user_id`；`loadAll` 读取共享表时不带用户过滤器；在两个租户下写入的共享单位分别落入各自的租户 schema。同一文件的按用户用例持续钉住默认的 `(unit, user_id, table_name, key)`/`(unit, user_id)` 键。
