# Agent Note: The tenant question channel answers through the business plane

Status: implemented

English | [中文](2026-10-08-tenant-question-channel.zh.md)

## Problem

The model can ask a human through `ctx.userQuestions`, but the tenant stack mounted the seam's spine row and no provider, so every `ask_user_question` call failed with `no user-questions provider is registered` — a composition that states the capability exists while nobody can answer it. The tool itself was not mounted either, so the model had no `ask_user_question` at all.

The tenant stack also has a business plane the answering humans already use: the bearer-authenticated `/api` surface and its `events.mux` stream. A question reached neither. It existed only inside the asking tool call's args, and no method accepted an answer, so the one party expected to answer — a data-mining analyst working in the tenant's business client — could not see the question or reply to it.

## Decision

Questions and their resolutions are durable session events, appended by a tenant-side provider for the existing seam; answers arrive through the business plane as two of its own methods.

### `@deepseek-ai/dsh-tenant-questions` provides the seam

The package extends `Service` and registers a `UserQuestionProvider` through `ctx.effect`, so the seam keeps one provider per registration and disposal removes it. It injects `userQuestions` only; the tenant authority it needs is the ambient request scope, not an injected service.

An ask is bound to the (tenant, subject) **and** the session it came from: `ask` reads `requireTenant()` / `requireUser()` and the asking agent's session, refuses an ask with no agent (`ASK_MISSING_AGENT`), outside an authenticated request (`NO_QUESTION_SCOPE`), outside an open turn (`NO_OPEN_TURN`), or with a repeated question id (`DUPLICATE_QUESTION_ID`), then records the ask and parks the provider call until the business answers, its own deadline passes, or the ask is withdrawn.

### The pair is logged as `user-question/asked` + `user-question/decided`

Both members are log-only, durable, and replayable, following the `approval/*` audit pair: no `surfaceOp`, never in the model transcript, no `ignorable`. `questions` is the ask exactly as the tool call submitted it, so a business subscriber renders the question from the event alone and needs no second read. `decided` carries `outcome` (`'answered' | 'timed-out' | 'cancelled'`) and the accepted answer exactly when the outcome is `'answered'`.

No new push channel exists. `MuxFrame` already carries every session event as a `session/event` frame, so a business client subscribed to the stream it already has sees both events as they are appended.

### `list` and `answer` are the channel's business methods

`TENANT_QUESTION_METHODS` names them (`tenantQuestion.list`, `tenantQuestion.answer`) and pairs each wire name with the `ctx.tenantQuestions` call it makes. `agent-http` answers a method in that table before delegating to the gateway, under the authority it already established for the request, and with the gateway's own two-level parse: a non-JSON media type is 415, a body that is not JSON is 400, an unreadable envelope or a path/method mismatch is a 200 `bad-request` `ServerResponse`, and a rejected payload is the same 200 `bad-request` with the field-level issues. A crash inside the channel is the carrier's own 500, and an unmounted channel is 503 rather than a silent 404.

The answer payload is validated against the ambient subject's **live** asks, so it cannot name a foreign, stale, or unknown question: the schema is one branch per live ask of this (tenant, subject), each requiring the exact session id, the exact question id, and an answer that covers every question of that ask exactly once, with no unknown ids, no duplicates, no label the question did not offer, and neither a label nor text for an item. A payload aimed at anything else fails validation with the specific field path.

An answer is reported accepted only once its resolution is logged. The channel claims an ask by removing it from the pending table — so the first of answer, deadline, abort, or disposal to claim it settles one outcome — and appends `user-question/decided`; when the log refuses that append (a turn that closed between the ask and the answer leaves the pair un-enclosed), the business client is told the failure, the waiting tool call is released with the log's own failure instead of the deadline, and no acceptance is reported for a decision the session log does not carry.

### The deadline is configuration, and its expiry is an error

`answerTimeoutMs` is a validated `Config` field (default 60000). When it expires the ask rejects with `ANSWER_TIMEOUT` — naming that no answer arrived, that the deadline is why, and that the model should state its assumption and proceed rather than ask again — and the pair is completed with `'timed-out'`. No answer is invented and no default option is selected.

The tenant spine configures the channel below the seam's own window (`360000` for the `user-questions` row, the channel `300000`), because reaching the seam's deadline aborts the ask: the model would then see the seam's `NO_ANSWER` and lose the reason this channel exists. Five minutes is the window an analyst working a case has to answer before the turn proceeds without them; it is also the lifetime a business client must treat a rendered question as answerable, since an expired ask leaves `list` and `answer` refuses it.

### Assembly

Two rows join the tenant spine: `tool-ask-user` (the model-facing tool) and `tenant-questions` (the channel, with an explicit `answerTimeoutMs: 300000`). `compose.ts` probes both `userQuestions` and `tenantQuestions` as required services, each gated on its row, so a channel row enabled without the seam fails the boot by name instead of leaving a silently absent surface.

## Alternatives considered

**Add a push channel for questions.** Rejected: the owner's decision fixes the channel as session events plus one answer method, and the mux stream already carries every session event to every subscriber. A second channel would duplicate delivery and need its own authentication.

**Add the methods to the shared gateway's method map.** Rejected: that map is closed, compiled against `RpcMethodMap`, and identical in every deployment, so a multi-tenant-only method cannot live there without giving the single-user surface a method it must refuse. The carrier answers its own methods first and delegates everything else.

**Record questions as `approval/*` events.** Rejected: approval is a permission decision with a closed outcome vocabulary attached to a tool call, and the approval service consumes its own pair. A question to a business user carries a question batch and a free-text-capable answer; sharing the event types would make each consumer parse the other's payloads.

**Answer from the seam itself (`ctx.userQuestions`).** Rejected: the seam owns the ask/answer protocol for one process's answerers; making it tenant-aware would push tenant authority and persistence into a capability definition that the Web, TUI, and ACP compositions share unchanged.

**Keep the pending table in PostgreSQL.** Not needed for the shipped single-replica tenant service, and it would add a table and a schema to a channel whose pending set is a process-local wait. A multi-replica deployment needs sticky routing to the replica that asked; the limitation is stated in the package README.

**Wait indefinitely instead of timing out.** Rejected by the same owner decision as inventing a default: a turn that waits forever on an absent analyst is indistinguishable from a hang, and the model cannot report what it never learned.

**Add a `tenantQuestion.wait` long-poll method.** Rejected for now: the stream already delivers the ask, so a wait method would add a second delivery path for the same event plus a bound on how long a business request may hold a socket.

## Consequences

The model now gets a real answer, or an explicit reason it did not. A business client sees every ask and every resolution durably, in the same stream that carries the rest of the session, and answers through the same authenticated surface it already calls.

The channel's deadline must stay below the seam's. Nothing checks that ordering at load: the two values live in different plugins' configs, and the failure mode is silent — the model receives a correct but less specific error. The tenant spine states both values side by side and the package README records the coupling.

The pending table is process-local, so more than one replica must route a subject's answer to the replica holding the ask; otherwise the answer finds nothing and the ask times out. The two methods are absent from `/api/openapi.json` because that document describes the gateway's method map, so a business client discovers them from this note, the carrier's module doc, or the package README.

`user-question/asked` and `user-question/decided` are required-on-read: a build that does not know the tenant question channel refuses a session log containing them. They are additive members of `SessionEventMap` and do not change `SESSION_FORMAT_VERSION`.

### Verification

`packages/tenant/tenant-questions/tests/tenant-questions.spec.ts` runs the real seam over a real session store: an ask is logged, appears in the subject's list, is answered through the channel call, and resolves the parked provider with the same answer the pair records; free text and multi-question asks are covered; another subject, another tenant, a stale id, and a second answer to a claimed ask are refused; eleven malformed payloads are refused with `ZodError` while the ask stays waiting; the deadline rejects with `ANSWER_TIMEOUT` and logs `'timed-out'`; a withdrawn and an already-aborted ask log nothing or `'cancelled'`; the seam's own shorter deadline reaches the provider as an abort; a resolution the audit invariant refuses — the turn closed between the ask and the answer — releases the waiting turn with that refusal, from the answer and from the deadline alike, and leaves the pair unclosed rather than reporting a decision the log does not carry; a channel built without the plugin schema serves one ask end to end on its own deadline; disposal rejects the parked asks and stops providing the seam; and the two wire names reach `list` and `answer`.

`packages/tenant/tenant-questions/tests/invariant.spec.ts` pins the pair relation: a resolution with no matching ask, a repeated open id, a repeated question id, an ask with no question, an unknown outcome, an answer present without `'answered'` or absent with it, an unasked id, a question answered twice, and a question left unanswered are each refused; a session replayed from the log re-adopts an open ask.

`packages/tenant/agent-http/tests/agent-http.spec.ts` runs the two methods over the carrier with real bearer tokens: 401 without a credential, a list plus an answer that resolves the model's ask, another subject's answer refused with the payload detail, an unreadable envelope and a path/method mismatch as 200 `bad-request` with a salvageable `rpcId` echoed, 415 and 400 for the carrier-layer failures, 404 for a non-POST and for the same method name outside the `/api` prefix, 500 for a channel failure the envelope cannot describe, and 503 when the channel is not mounted.

`packages/tenant/tenant-app/tests/app.spec.ts` proves the assembly: the two rows mount their plugins with `answerTimeoutMs` `300000` and `360000` and the test asserts the channel's window is the shorter of the two, the `ask_user_question` schema is registered, and the channel row enabled without the seam fails the named-service check at boot.

Not covered by a repo test, and to be verified on a cluster by the owner: that a business client subscribed to `events.mux` renders an ask and its resolution end to end, that a real analyst's answer reaches the parked tool call, and that more than one replica behaves as the README describes. The repo's Web and ACP compositions mount their own answerers and are untouched by this channel.
