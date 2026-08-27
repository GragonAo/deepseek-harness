# @deepseek-ai/dsh-credentials-postgres

English | [中文](README.zh.md)

PostgreSQL-backed credentials provider for the multi-tenant carrier. The writable credential map (reference → value) lives in one storage unit named `credentials_doc` under the ambient (tenant, user) partition — the tenant's schema plus the in-primary-key `user_id` — so no tenant or user reads or writes a host-side `.credentials.yaml`. Resolution layers exactly as `credentials-local`, with the managed file replaced by Postgres:

```text
inherited process environment       (read-only, wins)
> postgres per-(tenant, user) store (provider-managed, writable)
> <cwd>/.env                        (read-only fallback)
> $DSH_HOME/.env                    (read-only fallback)
```

Only the writable store is per-(tenant, user); the inherited environment and the two `.env` layers are the process's own, never a tenant's or user's.

## Config

No configuration. The provider resolves the `postgres` backend already registered on the storage hub; the deployment supplies that backend's `connectionString` on the `storage-postgres` entry.

## Behavior

- **Per-call resolution.** Each `resolve()` reads the current (tenant, user)'s map from Postgres, so a change reaches the next operation without a watcher. The inherited environment is checked first, so the deployment's `DEEPSEEK_API_KEY` (loaded into the process) resolves without a database round trip.
- **(Tenant, user)-keyed writes.** `set()`/`unset()` require a tenant and user and write one `ref` record in that (tenant, user)'s partition; outside any scope they fail closed, and `resolve()` falls through to the environment and `.env` layers only.
- **Empty value is absent.** `set()` rejects the empty string; `resolve()` treats an empty stored value as absent, so unset and empty do not diverge.
- **Inherited environment cannot be shadowed.** When the process environment supplies a reference, `set()` and `unset()` reject: a write there would have no effect.
- **`.env` fallbacks ride the launch environment.** They resolve only when the product CLI provided its launch-environment snapshot; a bare composition resolves the process environment alone.

## Model Experience

Indirectly, through the credential consumers that call `ctx.credentials.resolve()`; the provider stores and returns values but renders no model-visible text itself.

#### KV Cache effect

No direct invalidation; the consuming capability owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No cross-process hot-reload.** A value changed directly in Postgres by another process is not observed until the next `resolve()` (always fresh) — an unrequested push notification to the credential seam is deferred.
- **One document per (tenant, user), no per-reference lease.** Concurrent writes to the same reference resolve last-write-wins; there is no compare-and-swap on a single credential.