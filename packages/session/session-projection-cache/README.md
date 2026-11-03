# @deepseek-ai/dsh-session-projection-cache

English | [中文](README.zh.md)

The persisted projection cache (`ctx.sessionProjectionCache`): durable checkpoints of every registered projection unit's state, one record per session on the domain data form (`session_projcache` domain — the shipped json backend lands it beside `workspace.json` under the configured storage root). Design authority: the [session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) (persisted projection cache section).

A stored row `(key → {ver, seq, val})` is a fold shortcut, never an authority: possibly stale (`seq` says exactly how stale) but never wrong. Consequences the implementation commits to:

- **Every background write is fail-soft.** A failed durable write logs a warning and keeps the cache stale; the next write or cold read self-heals. A crash between writes costs a longer tail replay, never a wrong value.
- **A `ver` mismatch against the live unit's `stateVersion` discards, never migrates.** A unit bump invalidates its rows at read time; the key refolds from the log.
- **Whole-record writes.** Each write replaces the session's full checkpoint (the registry cut is always complete), snapshotted through the lossless-JSON boundary — a unit state violating the plain-JSON contract fails loud.
- **Records are bound to a log lifecycle, not just an id.** Each record stores the header identity (`createdAt`, `cwd`) it was folded from; every read validates it (the live or stored header is the witness) before accepting a row, so a deleted-then-recreated id or a persistence store swapped under a surviving cache discards the unrelated record instead of seeding phantom values.
- **The log leads, the cache follows.** A live checkpoint flushes the session's buffered events durably BEFORE the cache row lands, so a crash can leave the cache behind the log (a longer tail replay) but never ahead of it.

## Write policy

Two mandatory points, throttled in between:

| Trigger | Nature |
|---|---|
| `turn/end` | Mandatory — the turn-final value is what cold reads want. |
| Session disposal (detach) | Mandatory — the live-to-cold moment; after it the cold ladder serves this session. |
| `writeEveryEvents` committed events | Config throttle (count). |
| `writeIntervalMs` since the first dirty event | Config throttle (interval). |

Both throttle `Config` fields are required (no defaults): flush cadence is a deployment choice with no universally correct value, stated in cordis.yml.

## Request partitions

The cache serves a partitioned deployment. It loads the `session_projcache` domain **lazily, per ambient request partition** (the `(tenant, user)` pair `ctx.partitionScope` reports), so a multi-tenant host keeps one stored checkpoint table per tenant and user and never serves one partition's rows to another; a deployment without a partition scope loads a single domain, exactly as a single-user host does. Each partition is loaded on its first use — a listing or a checkpoint write — not at plugin init, because init runs before any request scope exists.

`maxLoadedPartitions` (required, no default) bounds how many partitions stay loaded: each loaded partition holds that tenant-and-user's whole stored checkpoint table in memory. Loading another partition past the budget closes the least recently used one; its checkpoints are durable, so a later use reloads it from the medium and nothing is lost. Concurrent first uses of one partition join the in-flight load instead of opening the domain twice (the domain facility refuses a double open).

## Listing read (`cachedSnapshot(meta)`)

The no-log-read rung: whole values viewed straight from the identity-matching stored record (version-matching keys only), returned as a `{asOfSeq, values}` cut — `asOfSeq` is the lowest served-row watermark, so a client seeding its per-session value store under higher-seq-wins can never let a stale list block overwrite a newer push frame. `undefined` when no usable record exists (unknown id, unrelated lifecycle, or no version-matching rows); the api-proxy list carrier turns that into an absent column, and a miss there continues into `coldSnapshot` for that one session, so the row is written back and the next listing reads stored rows only. The call is asynchronous because the first one in a partition resolves that partition's table; every later one reads memory.

## Cold read (`coldSnapshot(id, signal?)`)

The read ladder, zero full-log load on the happy path: cached rows → `sessionProjections.restoreFloor` (anchored one event below the lowest usable watermark) → persistence `readFrom(id, floor)` → `sessionProjections.restore` → fail-soft write-back of the refreshed rows. The anchor makes a shrunk log (crash-repair truncation) provable: an overreaching row triggers exactly one full re-read from seq 0 instead of serving a ghost value. No registered units serve `{asOfSeq: -1, values: {}}` without touching persistence; a session with no persisted log rejects with the seam's `not found`.

`write(session)` is the synchronous-cut checkpoint both mandatory points use; carriers may call it directly (not fail-soft — the fail-soft wrappers own containment).

## Composition

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
    maxLoadedPartitions: 1
```

Injects `storageDomain`, `sessionProjections`, `sessionPersistence`, `sessions`; reads the optional `partitionScope`. `maxLoadedPartitions` is one for a single-user host, and as many as the host serves concurrently for a multi-tenant one (the tenant service composition states 8). Without this row the projection system runs live-only (watermark cache; cold reads fall back to full log loads wherever a carrier implements them).

## Model Experience

None, as the cache only persists and restores host-side read models of already-logged session state and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the cache never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No eviction or retention surface** — records accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session persistence itself.
- **Interval throttle is per-session coarse** — the timer arms at the first dirty event after a clean write; a steady sub-threshold trickle writes once per interval, not a sliding window.
- **`coldSnapshot` reads are not deduplicated** — two concurrent cold reads of one session each run the ladder; last write-back wins (rows are equivalent), acceptable for listing-scale call rates.
