# @deepseek-ai/dsh-settings-postgres

English | [中文](README.zh.md)

PostgreSQL-backed settings provider for the multi-tenant carrier. One storage unit named `settings_doc` keeps every namespace section as a record under the ambient (tenant, user) partition — the tenant's schema plus the in-primary-key `user_id` — so a tenant's `settings.yaml` never lands on the host filesystem: the agent plane holds no host-side managed config files, and no tenant or user can read another's document.

Writes reopen the same contentless contract as the file provider — `load()` serves the whole document and `persist()` stores one merged section — only the medium differs.

## Config

No configuration. The provider resolves the `postgres` backend already registered on the storage hub; the deployment supplies that backend's `connectionString` on the `storage-postgres` entry.

## Behavior

- **(Tenant, user)-keyed.** Outside any (tenant, user) scope `load()` serves the empty document without touching Postgres, so a request without a tenant or user is safe; inside a scope, reads and writes resolve the ambient tenant and user at call entry. Each document lives in the tenant's own schema (`tenant_<id>_<hash>`) plus the in-primary-key `user_id`, so two users of one tenant keep separate documents.
- **One unit, one table.** The `settings_doc` unit declares a single `section` table whose keys are namespace names and whose values are raw sections; `hasGlobal` is unused.
- **Lazy per-(tenant, user) units.** A (tenant, user)'s unit handle opens on its first write and is reused for the process lifetime, then closed on disposal.
- **The base read path decides freshness.** Like every `SettingsProvider`, `load()` runs on the initial publish and again at each (tenant, user)'s first write; a read-only request sees defaults until a write (or another provider-side load) has surfaced that scope's document. This matches `settings-file`, not a deficiency of the Postgres medium.

## Model Experience

Indirectly, through consumers of `ctx.settings`: this provider only stores and publishes namespace sections, and each consumer's own surface documents any model effect.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No hot-reload of the medium.** There is no file watcher, so a section changed directly in Postgres by another process is not observed until the next write in this process or a restart; writes are the only durable path the settings seam exposes.
- **Read-before-write sees defaults.** A tenant's persisted document is loaded lazily on its first write per process, matching the base provider contract; making reads load on demand would widen the `SettingsProvider` read path from synchronous to asynchronous, a seam-level change deferred here.