# @deepseek-ai/dsh-storage-postgres

English | [中文](README.zh.md)

(Tenant, user)-keyed PostgreSQL backend for the storage hub. It serves the `kv` facet and registers as backend `postgres`; every per-user unit operation resolves the ambient tenant and user and targets that tenant's private schema plus the in-primary-key `user_id`, so a dropped predicate cannot structurally address another tenant's or another user's tuples. A case-shared unit (`shared: true`) stores under the tenant alone, with no `user_id`.

## Isolation model

- **One schema per tenant.** The schema name is `tenantPartitionName(id)` — a sanitized tenant-id prefix plus a 12-hex hash suffix, always a safe PostgreSQL identifier and ≤63 characters.
- **One user row per record.** `kv_record` keys by `(unit, user_id, table_name, key)` and `kv_global` by `(unit, user_id)`, so two users of one tenant keep separate records in the same schema.
- **Case-shared units (`shared: true`) store under the tenant alone.** `KvUnitDescriptor.shared` (default per-user) keeps a unit's records and global slot with no per-user `user_id`, in `kv_case_record` (primary key `(unit, table_name, key)`) and `kv_case_global` (primary key `(unit)`), so every subject of a tenant reads and writes the same case-level memory. Such a unit resolves `requireTenant()` only, and its double-open guard key is `${schema}.${name}` rather than `${schema}.${user}.${name}`.
- **Target-bound per operation, not per open.** `ctx.storageDomain` opens each unit once per process per (tenant, user), so the backend resolves `requireTenant()` and `requireUser()` at the start of every `loadAll`/`putRecord`/`deleteRecord`/`setGlobal` and carries the captured scope through the whole call. Outside an authenticated request the operation fails closed with `NO_TENANT_IN_SCOPE` (or `NO_USER_IN_SCOPE` for a tenant without a user).
- **Version stamping is per tenant.** Each tenant's schema stamps its own `kv_meta.version` at first use; a mismatch rejects with `version-mismatch`.

Each tenant schema hosts five tables: `kv_meta` (unit version, shared across the tenant), `kv_record` (`jsonb` record per `(unit, user_id, table, key)`), `kv_global` (one value per `(unit, user_id)`), `kv_case_record` (`jsonb` record per `(unit, table, key)`, no `user_id`, for case-shared units), and `kv_case_global` (one value per `(unit)`, for case-shared units).

## Configuration

```yaml
- name: '@deepseek-ai/dsh-storage-postgres'
  config:
    connectionString: 'postgres://dsh:dsh@localhost:5432/dsh'
```

The role must hold `CREATE` on the target database: each tenant's first write creates its own schema.

## Model Experience

### Tenant- and user-keyed persistence

#### What the model sees

Nothing. This backend serves the storage hub as backend `postgres`, below the model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **Single-process version stamping.** The `ensured` memo is host-local and not transactional; the `kv_meta` version is stamped without a concurrency guard for horizontally scaled processes.
- **Ambient-scope writes only.** Domains whose writes outlive the request's `runWithTenant`+`runWithUser` scope (e.g. async projection-cache flush) are not supported by a resolver that reads the ambient scope; such domains are out of scope for the vertical slice.
- **No connection liveness probe.** A dead pool surfaces as a query error rather than being detected at load; reconnect behavior is left to `pg`.
