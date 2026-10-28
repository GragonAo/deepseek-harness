# Agent Note: Hard-delete a stored session log

Status: implemented

English | [中文](2026-10-19-session-log-deletion.zh.md)

## Problem

A stored session could only grow. Every backend appended, the `SessionPersistence` seam exposed `create`/`append`/`load`/`inspect`/`readFrom`/`list` and nothing that removes, and each backend README stated the gap as a limitation rather than providing the operation: "Nothing deletes session files — logs accumulate under `root` until removed externally (the seam has no deletion API)" and "No deletion or background historical compaction — normal appends are insert-only". A host that must erase one conversation on request, or a deployment under a retention obligation, therefore had no supported call. The workarounds available to it — unlinking files under a root only the backend knows how to resolve, or running DELETE statements against a schema only the backend owns — bypass the operation serialization that keeps writes per-session consistent, so they can interleave with an in-flight flush and leave a half-removed session, or remove a log that the next buffered write creates again.

## Decision

### The capability is optional on the backend and stated on the service

`PersistenceBackend<TornMarker>` gains `remove?(id, signal?)`: it irreversibly deletes every artifact the backend holds under the id, metadata included, so `loadStored`, `readStoredRevision`, and `list` stop observing the session. It is optional because a provider may front storage it cannot delete; omitting it is how such a provider states that, and `PersistenceCoordinator.delete` then throws naming `backend.name` and saying that backend does not support deleting a stored session. The service definition states the capability as an abstract `SessionPersistence.delete(id)`, deliberately abstract: a concrete provider composes the coordinator or implements the removal itself, and neither path can inherit a silent no-op. All four first-party persistence providers implement `remove` and delegate `delete` to their coordinator.

### What `PersistenceCoordinator.delete(id)` does

1. Return immediately if this process already deleted the id; otherwise wait for a retirement in flight for it, then serialize behind any operation already queued for it, so the removal cannot interleave with a write, a repair, or a preparation for the same id.
2. Refuse a backend without `remove`, before touching anything.
3. Refuse a live session bound to the id whose turn is open: that log records work in flight, the Session would keep writing to a log that no longer exists, and the message carries the token `agent-busy` so a transport can map the refusal to its own rejection code. An idle live session (turn closed) is deletable — that is the ordinary case, since a host holds the Session it just finished using.
4. Call `remove`, record the id in an in-process tombstone, and drop the coordinator's bookkeeping for it: the session write state, the live controller (cancelling its batching window, so its buffered tail is dropped rather than retried), and the cached prepared source.
5. Deleting an absent, never-materialized, or already-deleted id resolves: a removal is not an assertion that the session existed.

The tombstone is what makes the deletion hold for the rest of the process. `load`, `inspect`, `readFrom`, `prepare`, `list`, and `listSnapshots` report the id as absent rather than as an empty session, and `create`/`append` reject with a message naming the deletion (`cannot append session "x": its stored log was deleted in this process`) instead of re-materializing the log.

### The tombstone is deliberately in memory

After a restart nothing is live, no controller buffers events, and no writer remains that could re-create the log, so the durable absence the backend reports is the whole truth and the id is free again. A durable tombstone would have to be committed before the log is deleted — otherwise a crash between the two leaves a session that is listed but unreadable — and the process-local set would still be needed for the write refusal, which is two mechanisms for one fact. What a host that needs the deletion to outlive the process relies on is that the storage is actually gone, which is what `remove` guarantees.

### Removing a live session's log does not dispose the session

The coordinator has no authority to dispose a `Session` another plugin still uses, so `delete` leaves the live Session in memory with no durable target. Its next write reports the deletion through that write's own failure path: an explicit `session/flush` rejects, while a background write logs one warning and retains its batch. Backend teardown skips the drain for a tombstoned id and cancels its batching window, so deleting an idle session and then shutting down does not fail teardown with a `dispose failed` `AggregateError` for a log the caller deleted on purpose; the skipped buffer belonged to that log. The live log therefore stays reachable through the Session until its owner disposes it, which is the same memory story as any live session.

### Per-backend removal

- **JSONL** unlinks the single artifact for the root's configured encoding through the same path resolution every other operation uses, covering `session.jsonl` and `session.jsonl.zstd` and refusing a root that holds the opposite encoding. The session directory and project directory stay: discovery treats a directory carrying a transcript as a session, so an empty directory is not one, and the directory is documented as reserved for other session-owned artifacts that a recursive removal would take with it.
- **SQLite** deletes both tables' rows for the id in one `BEGIN IMMEDIATE`, revalidating the schema under the lock, so a schema change observed at mutation time rolls the whole removal back. It states its own two deletes instead of relying on the schema's foreign-key cascade, so the row set a removal covers is visible at the call site.
- **PostgreSQL** deletes both tables' rows for the id in one transaction, in the (tenant, user) scope that owns the id: the binding captured by materialization or a successful read is reused exactly as append reuses it, and an id this process never bound is resolved from the ambient scope. The id's binding is released with its rows.

## Alternatives considered

- **Soft delete: hide the session, keep the bytes.** Rejected: the read family would have to filter a marker on every path, the bytes a retention obligation exists to remove would stay, and a hidden-but-present session keeps inviting the out-of-band `rm`/SQL workaround this change replaces.
- **Delete the whole session directory in JSONL.** Rejected: the directory is reserved for additional session-owned artifacts, an empty directory is not a session, and a recursive removal would reach files this backend never wrote.
- **Rely on the SQLite foreign-key cascade for child rows.** Rejected: the removal would then depend on a constraint remaining declared as it is, and the deletes it performs would not be readable where the removal is implemented.
- **Refuse to delete any id that still has a live Session.** Rejected: a host holds the Session it just finished using, which is exactly the session a user asks to erase, so the guard would push a disposal requirement onto every caller while the tombstone already makes the log stay deleted.
- **A durable tombstone row or marker file.** Rejected: it needs a commit before the deletion to be safe across a crash, and it does not remove the need for the in-process refusal.
- **A separate deletion service or seam.** Rejected: removal is one operation on storage the existing seam already owns, and a second seam would give every backend two places to state the same capability.
- **Expose the tombstone as a public query (`isDeleted`).** Provided: `SessionPersistence.isDeleted(id)` forwards to the coordinator's tombstone set, because a consumer must be able to tell a deleted id from a never-created one, which the seam's other reads answer as "absent" alike. The write refusal stays where the write is made, in the coordinator's `assertNotDeletedWrite`, and the read stays process-local with the set it reports: after a restart the durable absence is the whole truth.

## Consequences

- A host can now erase one session through the same per-id serialization that orders its writes, and each provider states the capability instead of inheriting a no-op.
- Removal is per session and per id: there is no age-, size-, or count-based retention policy, no bulk delete, and no way to remove part of a log — the append-only invariant is unchanged.
- Neither SQL backend returns file space: SQLite keeps its freelist pages and PostgreSQL keeps its pages, so reclaiming disk remains out-of-band `VACUUM`/autovacuum. JSONL leaves the empty session directory. Both are recorded in the backend READMEs.
- The live in-memory log of a deleted session is not freed by `delete`; a host that cares disposes the Session.
- Every `SessionPersistence` implementer must now state the capability, including test doubles: five test doubles in other packages gained a one-line implementation in this change.
- Nothing durable records that a session was deleted, so a restarted host can create the same id again — stated in the service JSDoc, the seam README, and the Agent Note rather than enforced.

### Verification

- `packages/session/session-persistence/tests/coordinator-contract.ts` runs four deletion cases against every coordinator-backed fixture (in-memory reference, JSONL `none`, JSONL `zstd`, SQLite): the read family (`list`, `listSnapshots`, `load`, `inspect`, `readFrom`, `prepare`) reporting a deleted id as absent with the surviving session intact and repeat/never-stored deletions resolving; the `agent-busy` refusal followed by a successful deletion of the same session once its turn closes; a live Session whose log was deleted failing its next write, not reviving the log at teardown, and a second instance over the same storage still finding nothing; and a second coordinator re-creating the id, proving the tombstone did not become durable state.
- `packages/session/session-persistence/tests/persistence.spec.ts` covers the capability refusal naming the backend, and the coordinator bookkeeping a removal clears (write state, live controller, cached prepared source).
- `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` and `zstd.spec.ts` cover the unlink for both encodings, the session directory surviving, discovery ignoring it, absent-id and missing-root no-ops, and a pre-aborted signal; `packages/session/session-persistence-sqlite/tests/sqlite.spec.ts` covers physical row removal in both tables, the transaction rollback when the schema changed, and a pre-aborted signal; `packages/tenant/session-persistence-postgres/tests/store.spec.ts` covers the owning-scope deletes with the bound scope, the binding release, the ambient-scope path, and a pre-aborted signal.
