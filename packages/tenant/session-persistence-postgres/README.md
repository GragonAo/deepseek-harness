# @deepseek-ai/dsh-session-persistence-postgres

English | [中文](README.zh.md)

(Tenant, user)-keyed PostgreSQL provider for the `SessionPersistence` seam. Logical sessions are unchanged; the physical backend keeps each session's immutable header in `session_meta` and its event-sourced log as full-JSON rows in `session_event`, both inside a per-tenant schema, with a `user_id` column on each row keeping one authenticated subject's log apart from another's.

## Isolation model

- **One schema per tenant.** The schema name is `tenantPartitionName(id)`, a sanitized tenant-id prefix plus a hash suffix (≤63 chars, safe PostgreSQL identifier). A request can only ever address the tenant its authentication minted.
- **One `user_id` column per row.** `session_meta` and `session_event` carry the owning user's id alongside each session id, so two users of one tenant keep separate rows in the same schema.
- **Reads resolve the ambient tenant and user.** `loadStored`/`readStoredRevision`/`loadStoredFrom` read `requireTenant()` and `requireUser()` at call entry and query `WHERE id = $1 AND user_id = $2`, so a cross-tenant or cross-user session id is unaddressable by construction — it simply resolves to "absent" (`undefined`). `list`/`listSnapshots` return only the ambient user's sessions, empty outside any scope.
- **Writes are owning-(tenant, user) bound.** The store captures the (tenant, user) at materialization (first `appendBatch`) and at any successful read, then reuses that binding for later asynchronous flushes that may outlive the request's `runWithTenant`+`runWithUser` scope. Falls back to the ambient scope for request-scoped repair of a session this process never materialized.
- **Durable agreement checked.** `session_meta.tenant_id` is stored alongside each header; a load refuses any row whose `tenant_id` disagrees with the ambient tenant.

`appendBatch`/`commitRepair` run in a single transaction, so no torn tail exists and `tornMarker` is never emitted.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-session-persistence-postgres'
  config:
    connectionString: 'postgres://dsh:dsh@localhost:5432/dsh'
```

The role must hold `CREATE` on the target database: each tenant's first write creates its own schema.

## Model Experience

### Tenant- and user-keyed session persistence

#### What the model sees

Nothing. The provider serves the `ctx.sessionPersistence` session store below the model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **No per-session (tenant, user) authority held across a server restart.** The owning binding is host-local; a resumed session is re-bound by its next successful read under its (authenticated) tenant and user.
- **No header-version divergence policy beyond the coordinator's check.** The store persists `version` verbatim and lets `PersistenceCoordinator` reject unsupported versions.
- **No connection liveness probe.** A dead pool surfaces as a query error; reconnect behavior is left to `pg`.