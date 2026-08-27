# Agent Note: Case-shared KV units

Status: implemented

English | [中文](2026-08-26-case-shared-kv-units.zh.md)

## Problem

The per-user storage partition ([2026-08-26](2026-08-26-per-user-storage-partition.md)) keyed every KV record and global slot by `(tenant, user)`, so two collaborators of one tenant each read only their own memory. Some memory is case-level, not user-level: one case is one tenant ([2026-08-26](2026-08-26-tenant-user-membership.md)), and every subject admitted to that case must read and write the same records — one case, many sessions share case-level memory (一案多会话共享案件级记忆). A per-user unit cannot carry that memory, because each user's writes and reads resolve its own `(unit, user_id, table_name, key)` stripe; the durable layer needs a tenant-only stripe beside the per-user rows.

## Decision

Add an optional `shared?: boolean` to `@deepseek-ai/dsh-storage`'s `KvUnitDescriptor` (omitted means per-user). When `shared === true`:

- `@deepseek-ai/dsh-storage-postgres` stores the unit's records in `kv_case_record` (primary key `(unit, table_name, key)`) and its global slot in `kv_case_global` (primary key `(unit)`), both tables created in `materialize()` beside `kv_record`/`kv_global`. A shared unit's `loadAll`/`putRecord`/`deleteRecord`/`setGlobal` resolve `requireTenant()` only and never read the ambient user, so a tenant scope alone suffices.
- A shared unit's double-open guard key is `${tenantPartitionName(tenant.id)}.${name}` instead of `${tenantPartitionName(tenant.id)}.${userPartitionName(user)}.${name}`: the same declared unit opens once per tenant, not once per (tenant, user).
- `kv_meta` version stamping is unchanged — one stamp per unit, shared across the tenant's users.

The shared tables carry no `user_id` column at all, so a case-shared row is unaddressable by user by construction: there is no user dimension to leak to.

## Alternatives considered

- **A reserved `user_id` (`NULL`, `''`, or a sentinel) in the existing `kv_record`/`kv_global` tables** — rejects: those tables keep `user_id` in the primary key precisely so a dropped predicate cannot cross the user boundary; a case row behind a sentinel would be a magic value every per-user query must remember to exclude, and `NULL` cannot sit in a primary-key column. Two dedicated tables make case-sharing a difference in the key, not a special value.
- **A scope enum (`'case' | 'user'`) on the descriptor instead of a boolean flag** — rejects: `shared?: boolean` mirrors the descriptor's existing optional `hasGlobal` and keeps the per-user default unwritten; a case-shared unit differs from a per-user unit only in whether the `user_id` column participates, which the boolean states without introducing a second kind.

## Consequences

Bought: a case's shared memory sits beside per-user memory in the same tenant schema, so every subject of a case reads and writes one shared record set and global slot while their private per-user rows stay separate. Case-sharing stays tenant-bounded (the schema is still per tenant), so one case's shared memory never crosses into another tenant.

Cost: case-shared records are last-writer-wins across the case's subjects, with no per-user audit of which subject changed a shared row. The flag is descriptor-level — `@deepseek-ai/dsh-storage-domain`'s `descriptorOf` projects no `shared` field, so a `DomainSpec` cannot declare a case-shared unit today, and only the multi-tenant Postgres backend reads the flag.

### Verification

`packages/tenant/storage-postgres/tests/backend.spec.ts` pins the behavior: a shared unit written under a tenant scope alone (no user) targets `kv_case_record`/`kv_case_global` with no `user_id` in the SQL; `loadAll` reads the shared tables without a user filter; a shared unit written under two tenants lands in each tenant's own schema. The same file's per-user cases keep pinning the default `(unit, user_id, table_name, key)`/`(unit, user_id)` keys.
