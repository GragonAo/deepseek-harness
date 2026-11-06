# Agent Note: A registry read opens its request partition before it projects it

Status: implemented

English | [中文](2026-11-05-registry-read-opens-its-partition.zh.md)

## Problem

Restarting the tenant host on 171 (`dsh/dsh-tenant-host`, tenant `cv5ajfbnoaykmug7dcvrpa`, user `cs`) brought five sessions the user had archived back into the session list. Nothing had been deleted: the partition's Postgres row still held the archive set (`kv_global`, `unit='workspace'`, `user_id='cs'`, `version=2`, five ids), and the same five ids sat in `archivedSessionIds` after a later write republished them. What the restart changed was the projection: `workspace.list` answered `{"items":[],"archivedSessionIds":[]}` and `session.list` returned all 29 sessions, five of which the user had put away. One idempotent `workspace.archiveSession` call on an already archived id — a call that writes nothing — restored both surfaces, and the listing dropped to 24.

The mechanism is the lazily-opened partition. `WorkspaceRegistry` opens a request partition in `ensurePartitionState()`, which only asynchronous methods call, so a partitioned deployment boots `[Service.init]`'s `NO_TENANT_IN_SCOPE` path into an uninitialized state whose projections answer empty. The gateway's `workspace.list` handler projected `list()` and `archivedSessionIds` synchronously, and the tenant carrier filtered `session.list` against the same synchronous getter, so every read served by a process that had not yet written anything described an empty registry. The client was not at fault: its own filtering was correct, and the empty baseline it received made every archived session visible again. The same gap reached `sessions.create({workspaceId})` and `sessions.fork`, which resolve a workspace through the synchronous `get()`/`list()` and would answer `workspace-not-found` until something else wrote.

## Decision

`ctx.workspaceRegistry.ensureLoaded()` opens the ambient request partition and resolves once its domain, header index, and entity cache are built. It is the read gate for the registry: the open memoizes, so a repeated call costs a promise hop.

Three call sites await it before projecting:

- the gateway's `workspace.list`, whose `items` and `archivedSessionIds` are the client's reconnect baseline;
- the tenant carrier, once per authenticated request, in `loadRegistryPartition()` before it delegates to the gateway.

The carrier gate is what makes the synchronous projections correct for a whole request rather than at one handler: inside `runWithTenant` + `runWithUser` the ambient partition is the request's, so opening it there serves `session.list`'s archive filter, `sessions.create`'s workspace lookup, `sessions.fork`'s inherited workspace, the `workspace.*` handlers that read before they write, and the `events.host` stream's frame-dedup baseline. A workspace-storage fault at that gate is logged and swallowed, because the registry is one service behind a carrier that also answers requests which never touch it; the gateway's `workspace.list` lets the fault through, because a client acting on an empty archive set is the defect this gate exists to prevent.

A single-partition deployment is unchanged: `[Service.init]` already opens its one partition, and `ensureLoaded()` returns immediately.

## Alternatives considered

**Open every known partition at boot.** The partitioned backend rejects an open outside a partition (`NO_TENANT_IN_SCOPE`), the set of partitions is unbounded and known only to the medium, and each open loads that tenant-and-user's registry state, so a host serving many tenants would pay the whole corpus at startup for reads no one has asked for yet.

**Make `list()` and `archivedSessionIds` asynchronous end to end.** They are read by synchronous derivation — a workspace entity's `sessionIds` projection, the client-facing view builders, the invariant checks — so the change would ripple through every consumer to fix a lifecycle problem that one awaited open solves at the request boundary.

**Make the host stream open the partition itself, by turning `events.host` into an async generator (built, reverted).** Awaiting the load inside the stream body defers registering the `session/created`, `agent/status`, and `domain/changed` subscriptions to the first pull, so events emitted between opening the stream and its first read were lost — reversible in a test that pulls immediately, and a silent frame gap in a client that opens a stream and starts reading a moment later. The carrier opens the partition before the stream request reaches the gateway, so the stream keeps its synchronous body and its eager subscriptions.

**Move the archive filter into the gateway's `session.list`.** The carrier keeps its own ownership filter regardless, since cross-tenant scoping is the carrier's authority, and a second archive filter in the gateway would duplicate that decision across two layers instead of opening the partition the filter already reads.

**Warm the partition from a readiness probe or an operator recipe.** A probe can only warm the partitions it names, and the 171 incident was resolved exactly that way — one idempotent archive call per affected tenant — which is a manual step per restart per tenant, and nothing reports a tenant it forgot.

## Consequences

The first request of a process for a given (tenant, user) pays one partition open — one medium read and one bootstrap check — and every later request pays a memoized promise. Reads no longer depend on some earlier write having happened in the same process, so a restart preserves the archive set, the workspace list, workspace-id lookups, and inherited-workspace forks.

The registry keeps its synchronous projections, so its README's former limitation ("the first access inside a partition is empty until an asynchronous method opens that partition") now names the gate instead of the trap: a caller that skips `ensureLoaded()` still sees the pre-open empty projection, which is what the invariant-free, single-partition paths rely on.

## Testing

`packages/workspace/workspace/tests/workspace.spec.ts` covers the registry gate over the partition-keyed in-memory backend: a second harness boots over the same durable medium, projects empty before the load, projects the archived set and workspace order after it, and a neighbour (tenant, user) that loads keeps its own empty state.

`packages/host/apiproxy/tests/api-proxy-workspace.spec.ts` pins the gateway's baseline to the gate, and `packages/tenant/agent-http/tests/agent-http.spec.ts` pins the carrier's per-request open, including the fault path where a workspace-storage failure keeps the listing rather than answering 500.

## Related

- [The archive set as a registry-global field](../feature/2026-07-31-session-archive-global-set.md) owns the set's storage, wire, and client-baseline decisions; this note owns how its reads reach durable state.
- [Per-user storage partition](../architecture/2026-08-26-per-user-storage-partition.md) makes the partition carry the user, which is why an open is per (tenant, user) rather than per tenant.
- [Session forget removes registry accounting](../architecture/2026-10-19-session-forget-removes-registry-accounting.md) is the other path into the same set and rides the same gate.
