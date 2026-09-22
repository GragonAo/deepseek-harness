# @deepseek-ai/dsh-tenant-admin

English | [中文](README.zh.md)

Scope-gated tenant-administration service (`ctx.tenantAdmin`). It is the implementation behind the API surface `tenant.admin.*`: tenant CRUD, enable/disable, member admission, user-tier directory bootstrap, and the partition/directory lifecycle that keep one tenant's data and host directories isolated.

## Surface

Every method is refused with `tenant-forbidden` unless the ambient JWT scopes carry the administrative scope (`adminScope`, default `dsh:tenant-admin`).

| Method | Effect |
| --- | --- |
| `tenant.admin.list` / `.get` | List or resolve one record, including disabled tenants. |
| `tenant.admin.create` | Provision the partition, host directories, registry entry, and durable record. |
| `tenant.admin.update` | Change `name`, `workspaceRoot`, `toolsRoot`, or `network` (`id`/`dataRoot` immutable). |
| `tenant.admin.enable` / `.disable` | Toggle request admission at the carrier. |
| `tenant.admin.remove` | Delete the record; `purge: true` also drops the partition and archives the directories. |
| `tenant.admin.members.list` / `.add` / `.remove` | Admit or drop one subject; `add` bootstraps the subject's user-tier directories. |
| `tenant.admin.users.ensure` | Pre-create one subject's `usersRoot/<sub>/{config,skills,tools}` tree. |

## Isolation and lifecycle

- **Partition on create.** The schema lifecycle seam issues the tenant partition (`tenantPartitionName(id)` for Postgres) so a new tenant's providers share no storage with another tenant.
- **Directories on create.** `bootstrapTenantDirs` creates `dataRoot`, `workspaceRoot/shared` (plus `tools`/`skills`), and each admitted member's host directory.
- **Archive, never delete.** `remove(id, purge: true)` moves `dataRoot` and `workspaceRoot` under `archiveRoot/<id>-<timestamp>/`, then drops the partition. A purge archives rather than deletes host data.
- **Users are JWT subjects.** There is no user table: admission is a per-tenant `members` list, and a subject is anyone whose token `sub` resolves. `usersEnsure` materializes the user-tier directories before first use.

## Durability

Two optional seams give the surface persistence; a deployment mounts `@deepseek-ai/dsh-tenant-admin-postgres` (or another provider) to satisfy them. The service reads them by key (`ctx.get`), so a test assembly can run the surface in-memory.

- `tenantRecordStore` (`load`/`upsert`/`delete`) — the durable tenant list. Boot hydrates the live registry from it; a store record wins over a same-id config seed.
- `tenantSchemaLifecycle` (`provision`/`purge`) — the per-tenant storage partition.

## Configuration

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

Nothing. This service exists behind `tenant.admin.*` for operators; it adds no tools, prompts, or session events.

#### Token effect

Zero tokens on every request.

#### KV Cache effect

Independent of the model request prefix.

## Known Limitations and Deferred Work

- **No credential or user management.** Subjects are JWT `sub` values; the surface admits or drops them from a tenant's `members` but mints no credentials.
- **Record-only remove leaves orphans.** `remove` without `purge` deletes the record but keeps the partition and host directories; the operator is expected to re-create or purge.
- **Purge is not transactional.** Directory archival runs before the partition drop, and a failure between the two leaves an archived tree alongside a still-present partition.
