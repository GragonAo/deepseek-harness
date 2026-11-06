# @deepseek-ai/dsh-llm-providers-postgres

English | [中文](README.zh.md)

PostgreSQL-backed provider registry for the multi-tenant carrier. One shared storage unit named `llm_providers` keeps every administrator-managed provider route in its global singleton, opened outside any tenant scope so that value lives in the storage backend's `dsh_system` schema: every tenant of the deployment reads the same registry, and no host-side config file is involved. This is the durable half of provider management: the records here are what a management surface writes and what a routing consumer reads, so a provider added through the API applies to the next request without a restart.

## Config

No configuration. The store resolves the `postgres` backend already registered on the storage hub; the deployment supplies that backend's `connectionString` on the `storage-postgres` entry.

## Behavior

- **Deployment-wide, not user- or tenant-scoped.** The unit is opened once at activation, where no tenant is ambient, and declares `shared: true`; a shared unit opened that way addresses the backend's `dsh_system` schema for its whole lifetime, so a write issued inside a request's tenant scope still lands in the one registry. The table carries no `user_id` and no tenant dimension.
- **One unit, one value.** The catalog is the unit's `hasGlobal` singleton — `{ providers: [...] }` — not a table of independently versioned rows, because an administrator edits the registry as one document and every write replaces it. Reads are read-modify-write over the cached catalog, so one edit rewrites one row.
- **Validated at the storage boundary.** `upsert()` runs `assertProviderRecord` before writing, and the load path revalidates each row and skips an unusable one with a warning, so a corrupt record cannot take the healthy routes down with it.
- **Writes notify.** Each successful `upsert()`/`remove()` emits the seam's change notification after durability, which is how a consumer re-resolves routing in-process.

## Model Experience

Indirectly, through routing consumers: the records this store serves decide which endpoint a request reaches and how it authenticates. A record's `baseURL` and `models` narrow what a selector offers, and its `apiKey` authenticates the call instead of an ambient environment variable.

#### KV Cache effect

No direct invalidation; a routing consumer owns any request-prefix change when the route set it resolves changes.

## Known Limitations and Deferred Work

- **No cross-process invalidation.** There is no notification channel between processes, so a record written by another replica is observed after the next local write or the next read, not immediately.
- **One registry per database.** Two deployments sharing a PostgreSQL database share their provider routes; separating them needs a deployment key on the unit and a resolution path that reads it from transport configuration.
- **Credentials are stored as supplied.** The record carries the provider API key in the schema, which is the same posture as the existing Postgres credential and settings documents; encryption at rest is a deployment-level concern not implemented here.
