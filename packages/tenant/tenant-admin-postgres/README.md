# @deepseek-ai/dsh-tenant-admin-postgres

租户管理面的 PostgreSQL 持久化提供方。它注册 `@deepseek-ai/dsh-tenant-admin` 消费的两个接缝 —— `tenantRecordStore` 与 `tenantSchemaLifecycle` —— 使租户列表在重启后仍存在，并让每个租户拥有独立的 schema。

## 存储内容

- **`tenant_record`**（共享表）。每个租户一行：`id`、`name`、`data_root`、`workspace_root`、`tools_root`、`enabled`、`network`、`members`（`jsonb`）、`updated_at`。首次启动幂等创建。
- **每个租户一个 schema。** `provision` 执行 `CREATE SCHEMA IF NOT EXISTS <tenantPartitionName(id)>`；`purge` 执行 `DROP SCHEMA IF EXISTS <…> CASCADE`，因此硬删除会同时删除分区内所有提供方的表。

## 配置

```yaml
- name: '@deepseek-ai/dsh-tenant-admin-postgres'
  config:
    connectionString: 'postgres://dsh:dsh@localhost:5432/dsh'
```

角色必须对目标数据库持有 `CREATE` 权限：预置会为每个租户执行 `CREATE SCHEMA`，提供方在首次启动时创建 `tenant_record`。

## Model Experience

### Durability layer, not model input

#### What the model sees

无。该提供方只应答 `tenantRecordStore` / `tenantSchemaLifecycle` 接缝；不新增任何工具、提示词或会话事件。

#### Token effect

每次请求零 Token。

#### KV Cache effect

与模型请求前缀无关。

## Known Limitations and Deferred Work

- **没有迁移方案。** `tenant_record` 以当前列一次性创建；后续加列需要手工迁移。
- **members 经 `jsonb` 往返。** 成员顺序会保留，但以 JSON 数组存储；若该列是非法 JSON，加载时按空成员列表处理。
