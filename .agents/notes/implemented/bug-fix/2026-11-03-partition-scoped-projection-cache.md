# Agent Note: Load the projection cache per request partition so a cold listing reads checkpoints instead of whole logs

Status: implemented

English | [中文](2026-11-03-partition-scoped-projection-cache.zh.md)

## Problem

A production tenant host (171, tenant `fifiijshmsvi_soopxedqg`) answered `session.list` in 32.5, 33.1, 34.9 and 87.9 seconds, so the Java bridge in front of it folded every call into its 30-second read timeout and the case page failed with `upstream-unreachable`. The host was healthy: on the same socket `host.describe` answered in 0.02 s and `workspace.list` in 0.7 s, one 33-second listing added 53 CPU-seconds to the process's cgroup accounting on a 32-core box, and reading all 884 session artifacts off cephfs took 81 ms. Three tenants on that host ordered the cost by total event volume rather than session count — 0 events / 0.42 s, 527,201 events / 4.37 s, 4,521,054 events (2.14 GB of `jsonb`) / 32.5–87.9 s — which is one throughput, about 120,000–130,000 events per second, naming the mechanism: the listing folded every cold Session's entire log through the projection registry.

The projection system already has the remedy. `session-projection-cache` stores one checkpoint record per Session and `cachedSnapshot(meta)` serves a listed Session's projection column from it, and the gateway's cold listing reads that first; the miss path (`readFrom(id, 0)` plus a registry fold) exists for deployments that mount no cache. The tenant composition mounted none: `packages/tenant/tenant-app/src/spine.ts` disabled the row, on the reasoning that the cache opens its storage domain in `Service.init`, while the tenant storage backend resolves the tenant and user per operation (`currentTenant()` / `requireUser()` at call entry). A boot-time open has no ambient partition, so the domain would load one process-wide table shared by every tenant — a cross-tenant read of another tenant's checkpoints. Disabling the plugin was the only safe composition available, and it made the miss path the only path.

## Decision

`session-projection-cache` loads its domain lazily, per ambient request partition, instead of at init. `partition()` keys a `Map` by the `(tenantName, userName)` pair `currentPartition(ctx)` reports (the bare empty string without a partition scope, which is the single-user case) and, on a miss, opens the domain and binds its `sessions` table for that partition; a concurrent second caller joins the in-flight open, because the domain facility refuses a double open. `Config.maxLoadedPartitions` (required, no default) bounds how many partitions stay loaded: each loaded partition holds that tenant-and-user's whole stored checkpoint table in memory, so the count is a memory budget the composition states. Loading past the budget closes the least recently used partition's domain — the checkpoints are durable, so a later use reloads them and nothing is lost — and disposal closes every loaded domain.

`cachedSnapshot` is therefore asynchronous: the first call in a partition resolves that partition's table from the medium, and every later call reads memory. `coldSnapshot` and the write-behind paths resolve the same way, keyed off the partition ambient at call entry.

The tenant composition mounts the cache (`writeEveryEvents: 200`, `writeIntervalMs: 5000`, `maxLoadedPartitions: 8`), and the browser composition states `maxLoadedPartitions: 1`. The single-user shape is unchanged: no partition scope, one domain, one table.

The gateway's cold listing column gains the last step of the ladder: a stored-row miss continues into the cache's `coldSnapshot(id, signal)` for that one Session, which reads the tail from the registry's anchored floor and writes the refreshed checkpoint back (fail-soft). A Session that had no checkpoint therefore pays one fold, not one per listing, and the next listing of it is a stored-row read. A deployment that mounts no cache keeps folding the log directly, as before.

## Alternatives considered

**Memoize the derived row in the gateway under the persistence revision (built, measured, reverted).** `listSnapshots()` hands each cold Session's durable revision to the listing for free, and a row memoized under that revision can be re-served with no log read at all; on the 130 host it turned a repeated 8.6-minute listing into 50 ms. It is a second copy of the mechanism the cache exists for: the memo dies with the process, so the first listing after every restart still folds everything, it adds a bounded map of summary rows per gateway instance, and the isolation it inherits depends on one persistence backend's revision token embedding its schema name rather than on a stated contract. The checkpoint lives in the tenant's own Postgres schema and survives restarts, so the memo was reverted once the checkpoint path existed.

**Open the domain at init under the bare unit name.** The domain would load one process-wide table that every tenant reads and writes; the row keys are session ids, which are not namespaced by tenant. Cross-tenant reads would be reachable through a listing.

**Make the storage domain's table synchronously partition-resolving.** The domain's table is an in-memory snapshot built by one `loadAll()`; a partition can only be discovered by reading the medium, so the read is asynchronous by construction. Keeping `cachedSnapshot` synchronous would have meant either a stale-table fallback that silently disables the cache or loading every partition at boot, which is the memory growth the lazy design avoids.

**Backfill every stored Session's checkpoint at boot.** A separate pass over all logs on every start is the same cost, paid by a host that has not been asked to serve a listing yet, and it duplicates the ladder's write-back.

**Raise the bridge's read timeout, or ask operators to wait.** The cost is host-side derivation on the one event loop that also serves every other request; a longer timeout lets a 33-second listing occupy it for longer.

## Consequences

A cold listing costs one table read for the first listing in a partition and memory afterwards: no `session_event` read per Session, no registry fold, and no dependence on the tenant's total history. The fold still happens once for a Session whose checkpoint predates the cache or whose throttled write-behind had not fired — 171's tenanted histories pay that on the first listing after the deploy that introduces this, and never again, restarts included.

Memory is bounded by `maxLoadedPartitions` tables, each holding one tenant-and-user's checkpoint rows; eviction closes the least recently used domain, so a host that serves many tenants does not accumulate them. A checkpoint write that runs outside any request partition — a disposal during shutdown — is refused by the partition-scoped backend and stays fail-soft: a warning, and the row catches up on the next in-scope write.

The listing read is asynchronous, which moved two call sites: the gateway awaits it, and `subagent`'s child listing awaits it inside its cold-identity resolver.

## Related

- [Bounded cold blank verification](2026-08-13-bounded-cold-blank-verification.md) owns the one bounded read a cold row may make of an artifact; this note changes what happens when the stored checkpoint is absent.
- [Session projection and command log](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md) is the design authority for the persisted checkpoint.

## Testing

`packages/session/session-projection-cache/tests/cache.spec.ts` owns the partition policy: one domain opened per request partition and served from its own table, the least recently used partition closed and reloaded on the next use past the budget, and every loaded partition closed with the plugin. The existing ladder tests still cover the write-back, identity binding, and version-mismatch paths, now through the asynchronous listing read.

`packages/subagent/subagent/tests/list-children.spec.ts` and the gateway's cold-listing and projection suites pin the two adapted call sites.

On the 130 site the tenant with 652 Sessions and 17,798,462 events paid one fold after the deploy — 669.8 s, storing 652 checkpoints — and every listing since has been a stored-row read: 0.17 s in the same process, and 0.19 s, 0.35 s and 0.19 s in three fresh processes. The tenant's `session_event` `seq_scan`/`idx_scan` counters read 30/3330 before and after each of those restarted-process listings, so no listing read the log, and the response body stayed byte-identical at 902,727 bytes.
