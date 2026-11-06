# @deepseek-ai/dsh-llm-providers-postgres

English | [中文](README.zh.md)

PostgreSQL-backed provider registry for the multi-tenant carrier. One case-shared storage unit named `llm_providers` keeps every administrator-managed provider route as a record under the ambient tenant's schema — no in-primary-key `user_id`, so every subject of one tenant reads the same registry and no host-side config file is involved. This is the durable half of provider management: the records here are what a management surface writes and what a routing consumer reads, so a provider added through the API applies to the next request without a restart.

## Config

No configuration. The store resolves the `postgres` backend already registered on the storage hub; the deployment supplies that backend's `connectionString` on the `storage-postgres` entry.

## Behavior

- **Tenant-scoped, not user-scoped.** The `llm_providers` unit declares `shared: true`, so its records live in the tenant's `kv_case_record` table where the primary key carries no `user_id`. Two users of one tenant see one registry; another tenant's schema holds its own.
- **Reads outside a tenant fail safe.** With no ambient tenant, `list()` serves the empty list and never touches Postgres — which is exactly the state that leaves the configuration tier as the only provider source.
- **One unit, one table.** Table `provider` maps a provider id to its record; `hasGlobal` is unused.
- **Validated at the storage boundary.** `upsert()` runs `assertProviderRecord` before writing, and `list()` revalidates each row and skips an unusable one with a warning, so a corrupt record cannot take the healthy routes down with it.
- **Writes notify.** Each successful `upsert()`/`remove()` emits the seam's change notification after durability, which is how a consumer re-resolves routing in-process.

## Model Experience

Indirectly, through routing consumers: the records this store serves decide which endpoint a request reaches and how it authenticates. A record's `baseURL` and `models` narrow what a selector offers, and its `apiKey` authenticates the call instead of an ambient environment variable.

#### KV Cache effect

No direct invalidation; a routing consumer owns any request-prefix change when the route set it resolves changes.

## Known Limitations and Deferred Work

- **No cross-process invalidation.** There is no notification channel between processes, so a record written by another replica is observed after the next local write or the next tenant-scoped read, not immediately.
- **Route topology is process-global.** A routing consumer registers routes per process, not per tenant, so two tenants that configure the same route id with different endpoints share whichever set was resolved last. Credentials are not affected: a request resolves the key from its own tenant's record.
- **Credentials are stored as supplied.** The record carries the provider API key in the tenant's schema, which is the same posture as the existing Postgres credential and settings documents; encryption at rest is a deployment-level concern not implemented here.
