# Agent Note: Per-user storage partition

Status: implemented

English | [中文](2026-08-26-per-user-storage-partition.zh.md)

## Problem

The multi-tenant slice ([2026-08-24](2026-08-24-multi-tenant-slice.md)) isolated every durable fact by tenant — one schema per tenant, a `tenant_id` on each row, one container per tenant — and the user identity and membership authority ([2026-08-26](2026-08-26-tenant-user-membership.md)) put the authenticated subject in request scope. The durable layers still keyed by tenant alone, so two subjects admitted to one tenant saw one shared KV store, session log, settings document, credential map, and workspace registry. Per-user isolation requires the partition to carry a `user_id` alongside the tenant, so a subject addresses only its own records.

## Decision

Widen the isolation unit from `tenant` to `(tenant, user)` across the durable and in-memory layers, layered on `runWithTenant` + `runWithUser`:

- `@deepseek-ai/dsh-storage-postgres` keys `kv_record` by `(unit, user_id, table_name, key)` and `kv_global` by `(unit, user_id)`; every `loadAll`/`putRecord`/`deleteRecord`/`setGlobal` resolves `requireTenant()` + `requireUser()` at call entry. `kv_meta` keeps its per-unit version stamp, shared across the tenant (no `user_id`).
- `@deepseek-ai/dsh-session-persistence-postgres` adds a `user_id` column to `session_meta` and `session_event`; per-id reads filter `WHERE id = $1 AND user_id = $2`, so a session id owned by another user of the same tenant resolves to absent. `list`/`listSnapshots` return only the ambient user's sessions, empty outside any scope. Writes capture the owning `(tenant, user)` at materialize and reuse it for flushes that outlive the request.
- `@deepseek-ai/dsh-settings` adds the protected `userScoped` getter (default `false`) beside `tenantScoped`; the in-memory document cache is keyed by the `(tenant, user)` scope key `tenant.id\0user` instead of the tenant id. `@deepseek-ai/dsh-settings-postgres` sets `userScoped = true` and stores its `settings_doc` unit per `(tenant, user)`.
- `@deepseek-ai/dsh-credentials-postgres` stores its `credentials_doc` map per `(tenant, user)`; `loadDoc` returns empty outside any scope.
- `@deepseek-ai/dsh-storage-domain`'s `partitionKey(name)` (the single-open guard) is `${tenantPartitionName}.${userPartitionName}.${name}` while both a tenant and a user are in scope, the bare name otherwise.
- `@deepseek-ai/dsh-workspace` keys the registry's partition state by the `(tenant, user)` partition, not the tenant.

Cross-user ids are unaddressable by construction and fail closed: a dropped `user_id` predicate, or a session id minted for another user of the same tenant, returns no other subject's rows.

## Alternatives considered

- **`user_id` as a query-level filter, not a primary-key column** — rejects: the tenant slice's invariant is that a dropped predicate still cannot cross the boundary structurally; putting `user_id` in the primary key keeps that property for the user dimension, so a bug that drops the filter still returns no cross-user row.
- **Null-byte vs. printable scope-key delimiter** — the settings scope key uses `tenant.id\0user` because no branded id in this codebase contains `\0`, so the composite cannot be forged or collide; a `/` or `.` separator could in principle appear in an id. The partition-name composites (`${tenantPartitionName}.${userPartitionName}.${name}`) delimit with `.` because both partition names are already `.`-free safe identifiers.
- **A nested per-user map inside the per-tenant cache vs. one flat composite key** — one flat key keeps the document cache and the per-namespace write queue on a single index, and matches the layered user authority rather than a second store shaped `Map<tenant, Map<user, doc>>`.

## Consequences

Bought: every durable and in-memory layer now partitions by `(tenant, user)`, so two collaborators of one tenant keep separate KV records, session logs, settings, credentials, domain projections, and workspace registries; `kv_meta` stays a shared per-unit stamp the tenant owns. Cross-user reads fail closed rather than leaking.

Cost: per-user providers now resolve two authorities per operation (`requireTenant()` + `requireUser()`), and a request without a user throws `NO_USER_IN_SCOPE` instead of serving tenant-wide data; the single-user path falls back to the unscoped/`''` key unchanged.

### Verification

Package suites pin the invariant: `packages/tenant/storage-postgres/tests/backend.spec.ts` (two users of one tenant keep separate rows; the double-open guard keys per `(tenant, user)`), `packages/tenant/session-persistence-postgres/tests/store.spec.ts` (a cross-user session id resolves `undefined`; `list` returns only the ambient user's sessions), and `packages/workspace/workspace/tests/workspace.spec.ts` (two users of one tenant keep separate registries). The `credentials-postgres` and `settings-postgres` provider suites enter `runWithTenant` + `runWithUser` scopes through the same helper.