# Agent Note: Bound the stream fan-out and batch event writes so a busy host stays responsive

Status: implemented

English | [中文](2026-11-03-stream-fanout-backpressure.zh.md)

## Problem

A production tenant host was restarted by its own liveness probe in the middle of three running turns, and those turns left no persisted `turn/end`: the work was lost and the clients saw a stream that simply stopped. Reconstructed from the cluster:

- One case wrote 572,231 session events in fifteen minutes — a streaming turn appends one `assistant/chunk` per token, and every one of them is persisted — peaking near 1,900 events/second.
- During that peak the process answered `GET /openapi.json` more slowly than the probe's 3 s timeout, so kubelet restarted it. It was never dead: it kept writing events until the SIGTERM, and it served the same endpoint in half a millisecond once idle.

The probe's threshold is a deployment fact (the tenant host manifests now carry a survivable one), but two amplifiers inside the harness made the box saturate in the first place, and both are visible in the code rather than inferred:

1. **Both SSE stages pushed instead of pulling.** `toFetchHandler`'s `sseResponse` and `agent-http`'s `scopedSseBody` were `start()` loops that called `controller.enqueue` for every frame as fast as the source produced them. `enqueue` never blocks, so the queue in front of a slow socket grows without bound: the socket layer does apply backpressure, but all it can do is stop reading, which is precisely what lets the queue grow. One suspended browser tab is then enough to fill the host's heap and stretch GC pauses across every request on the same event loop — including the probe.
2. **The per-subscription frame queue was unbounded.** Each `events.mux`/`events.host` subscription holds a `FrameQueue` that every broadcast pushes into; only the consumer pulls frames out of it. A reader that stops without closing — a suspended tab, a sleeping laptop — leaves the socket open, so the queue keeps every event of every attached session forever.
3. **Every persisted event was its own round trip.** `PostgresSessionStore.appendBatch` and `commitRepair` looped a single-row `INSERT` per event inside the flush transaction. The coordinator coalesces a flush for up to `writeBatchMaxDelayMs` (200 ms), so a 1,900 events/second burst became ~380 sequential statements per flush, several flushes at a time, all awaited on the one event loop that also answers HTTP.

## Decision

An SSE body is pull-driven, in both stages. `pull` asks the source for exactly one frame per free queue slot (`ReadableStream` holds one chunk by default), so a subscriber that stops reading parks the source instead of buffering it, and the two stages cannot stack their queues into an unbounded pipeline. A frame still in flight when the consumer cancels is dropped rather than enqueued (`detached`), and `cancel` does not await the source's `return()`: the source may be parked on a frame that never arrives, and the request signal, not the stream, is what ends the impl's iteration.

A subscription's queue is bounded at `MAX_BUFFERED_FRAMES` (20,000) frames. Past that the host stops serving it: the backlog is released and the iterator ends, which closes the SSE body. That is the same recovery as any other dropped stream — the client reopens and gets a fresh baseline with replayed approvals and questions — and it is the only recovery that puts the answerable frames a lagging reader missed back in front of the user. The overflow is logged, so an operator sees a subscriber that stopped reading.

`appendBatch`/`commitRepair` append events as multi-row `INSERT`s of `EVENT_ROWS_PER_STATEMENT` (200) rows each — 800 parameters per statement, far inside the wire limit — still inside the same transaction, so a flush stays all-or-nothing across its chunks and the torn-tail guarantee is untouched.

## Alternatives considered

**Raise only the probe thresholds.** Necessary and shipped in the deployment manifests, but not sufficient: it converts "killed after 90 seconds of overload" into "unusable for as long as the overload lasts", and the unbounded queue still grows toward the heap limit. It is a tolerance for slowness, not a fix for it.

**Stop persisting `assistant/chunk`.** The deltas are UI-visible but not model-visible, so the log could in principle keep only the final `assistant/message`. Rejected: the streamed text would no longer be replayable from the log, which breaks "model-visible ⟺ logged" in the direction clients rely on, and it is an on-disk format change to sell a write-amplification problem that batching already solves.

**Keep per-event statements and widen the batching window.** It reduces statement count only by making durability lag; the round-trip count per flush is unchanged, and a wider window delays every `turn/end` write with it.

**Bound the queue by dropping its oldest frames instead of ending the subscription.** Dropping keeps the stream open and the client detects the seq gap, but the oldest frames are exactly the subscription baseline and the pending approval/question requests — the answerable state a reader must not silently lose. Ending the subscription re-establishes all of it on reconnect.

**Wrap both streams in `TransformStream`.** The default transform queue also bounds to one chunk, but the scoping stage has to drop frames and re-split byte units, which a `TransformStream` expresses only by buffering internally — the exact thing being removed.

## Consequences

The cost: a subscriber that reads slowly now slows delivery instead of being served from memory, so its lag is visible as lag rather than as host memory growth, and a subscriber that stops for long enough is disconnected — a client-visible failure, chosen over a host-wide one. `controller.enqueue`-after-cancel is unreachable (the `detached` flag), which means a frame produced during a cancel is silently discarded — correct, since nobody can receive it.

The gain: fan-out cost is bounded by what consumers actually read, and a flush costs one round trip per 200 events instead of one per event — about two orders of magnitude fewer statements during a streaming burst, on the same event loop that serves every other request.

## Testing

`packages/host/apiproxy/tests/fetch-carrier.spec.ts` and `packages/tenant/agent-http/tests/agent-http.spec.ts` pin the bound directly: with 200 frames available and nobody reading, production stays inside one queue slot per stage (`<= 1` and `<= 2`), tracks demand as chunks are taken, and stops at cancel — plus the two cancel-in-flight paths (a frame in flight, a source that fails after the consumer left) resolve as `done` instead of resurrecting the stream. `packages/host/apiproxy/tests/frame-queue.spec.ts` owns the queue bound: frames arrive in order until the queue ends, and one frame past `MAX_BUFFERED_FRAMES` ends the subscription, releases the backlog (`done` on the next pull rather than a 20,000-frame replay), and reports the overflow once. `packages/tenant/session-persistence-postgres/tests/store.spec.ts` pins the write shape: one statement per flush, and 450 events split as `[200, 200, 50]` with every seq landing exactly once in order.

The deployment side of the same incident (probe thresholds, startup budget, resource requests) lives in the tenant host manifests, not in this repository's packages.
