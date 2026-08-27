# Agent Note: Tenant-keyed settings and credentials over Postgres

Status: implemented

English | [中文](2026-08-26-tenant-settings-credentials-postgres.zh.md)

## Problem

The multi-tenant carrier inherited the single-user `settings-file` and `credentials-local` providers. Both wrote tenant data to the host filesystem — `<tenant.dataRoot>/settings.yaml` and `<tenant.dataRoot>/.credentials.yaml` — so a multi-replica deployment could not share state, and a tenant's managed config survived as files on the host, which any host-side file read could surface to the wrong tenant. Statelessness requires every agent-plane configuration fact to live in the tenant-keyed durable store, with no host-side managed files.

## Decision

Ship two Postgres-backed providers and swap the multi-tenant bundle onto them, replacing the file providers for the carrier only — the single-user bundles keep `settings-file` and `credentials-local` unchanged.

- **`@deepseek-ai/dsh-settings-postgres`** — a `SettingsProvider` whose raw document is one storage unit `settings_doc` with a single `section` table. `load()` reads the whole document from the current tenant's schema and returns the empty document outside any tenant scope (fails safe, no query); `persist(ns, section)` writes one namespace record via `putRecord`. Unit handles open lazily per tenant and close on disposal.
- **`@deepseek-ai/dsh-credentials-postgres`** — a `CredentialProvider` whose writable map is one storage unit `credentials_doc` with a single `ref` table. Resolution layers exactly as `credentials-local` but with the managed file replaced by Postgres: inherited process environment (read-only, wins) → per-tenant store → the `.env` fallbacks carried by the launch environment. `resolve()` reads the current tenant's map per call, so a change reaches the next operation without a watcher.
- **Bundle swap** — `packages/bundle/multi-tenant/cordis.patch.yml` disables the base `settings` and `credentials` rows and inserts `settings-postgres` and `credentials-postgres`. The storage hub's existing `postgres` backend (already mounted for `storage-domain` and `session-persistence-postgres`) hosts both units, so no new connection medium is introduced.

Both providers declare `static inject = [storageBackendServiceKey('postgres')]` so activation cannot race backend registration, and resolve the backend through `ctx.storage.backend.get('postgres')`.

## Alternatives considered

- **Extend `settings-file`/`credentials-local` with a Postgres mode** — folded the tenant concern into single-user providers that own watchers, writer locks, and atomic file rendering, none of which apply to a schema row. Chosen: separate providers.
- **One shared KV unit for both providers** — couples two independent capabilities to one schema/version. Chosen: `settings_doc` and `credentials_doc` stay separate.
- **Store each namespace as a record vs. one JSON blob in the global slot** — per-record (`section`/`ref` tables) keeps a write to one namespace a single-row upsert and avoids a read-modify-write over the whole document. Chosen: record tables; the unit `global` slot is unused.

## Consequences

**Bought:** the agent plane holds no host-side managed settings or credentials files; settings and credentials are durable per tenant in Postgres and survive replica restarts; the `postgres` backend's `Unit` routing (per-tenant schema) already enforces cross-tenant isolation. Test-only compositions and the deployed carrier both boot the providers through the real Loader path with the storage hub mounted.

**Cost and deferred work:** a `SettingsProvider` loads a tenant's document on its first write per process (a read-only request still sees defaults), matching `settings-file`; making reads load on demand requires widening the base read path from synchronous to asynchronous. The code-runtime and workflow executors still run model code in the host process and remain the outstanding host-side file-access surface to containerize.

### Verification

`pnpm exec tsc -b` on both new package tsconfigs and the bundle passes; the two provider suites (per-tenant round-trip, isolation, fail-safe-outside-scope, environment shadowing) and one real-composition suite per provider pass via the Loader + a mock postgres executor; `packages/bundle/multi-tenant/tests/multi-tenant.spec.ts` asserts the disabled file rows and the mounted Postgres rows.