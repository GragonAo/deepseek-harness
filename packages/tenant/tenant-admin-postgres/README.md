# @deepseek-ai/dsh-tenant-admin-postgres

English | [中文](README.zh.md)

PostgreSQL durability provider for the tenant-administration surface. It registers the two seams `@deepseek-ai/dsh-tenant-admin` consumes — `tenantRecordStore` and `tenantSchemaLifecycle` — so the tenant list survives restarts and each tenant owns a private schema.

## What it stores

- **`tenant_record`** (shared table). One row per tenant: `id`, `name`, `data_root`, `workspace_root`, `tools_root`, `enabled`, `network`, `members` (`jsonb`), `updated_at`. Created idempotently on first boot.
- **One schema per tenant.** `provision` runs `CREATE SCHEMA IF NOT EXISTS <tenantPartitionName(id)>`; `purge` runs `DROP SCHEMA IF EXISTS <…> CASCADE` so a hard remove also drops every provider table inside the partition.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-tenant-admin-postgres'
  config:
    connectionString: 'postgres://dsh:dsh@localhost:5432/dsh'
```

The role must hold `CREATE` on the target database: provisioning issues `CREATE SCHEMA` per tenant, and the provider creates `tenant_record` on first boot.

## Model Experience

### Durability layer, not model input

#### What the model sees

Nothing. This provider answers the `tenantRecordStore` / `tenantSchemaLifecycle` seams only; it adds no tools, prompts, or session events.

#### Token effect

Zero tokens on every request.

#### KV Cache effect

Independent of the model request prefix.

## Known Limitations and Deferred Work

- **No migration story.** `tenant_record` is created once with its current columns; adding a column later requires a manual migration.
- **Members round-trip through `jsonb`.** Member order is preserved but stored as a JSON array; invalid JSON in the column is treated as an empty member list on load.
