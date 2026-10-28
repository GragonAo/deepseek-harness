# Agent Note: Deliverable declarations as the one source of a turn's artifacts

Status: implemented

English | [中文](2026-10-28-deliverable-declarations.zh.md)

## Problem

A business front end must show, under each completed turn, the files that turn handed to the user — and only those. Nothing in the session log answered that question. Which files a turn wrote was inferable only from tool traffic: a write tool's arguments, a terminal card's declared outputs, a diff card's locations. Every consumer rebuilding "what did this turn deliver" re-derived that from render intents, and the derivation was wrong in both directions. It counted scratch files, extracted intermediates, and drafts, because those are writes too. It missed files produced by a command whose output never named them. It required paging the log backwards to a `turn/start` boundary for each turn a UI wanted to draw, which is one page fetch per bubble. No two consumers agreed: the same log produced a different list depending on which card kinds a given consumer happened to recognize.

The consumer here is a case-management front end that shows a per-turn artifact row. Its requirement is not "files this turn touched"; it is "files this turn delivered", and that distinction is the model's to make, not a heuristic's to guess.

## Decision

### The model declares; nothing infers

The new `@deepseek-ai/dsh-tool-present` package registers one tool, `present`, whose only argument is the list of files the turn delivers and, per file, a one-line description. The tool's contract is a declaration, not an observation: it appends a `deliverables/presented` session event carrying the turn, the calling `callId`, and the resolved file list. It writes no file, reads no file content, and adds no model-visible output beyond the acknowledgement that the declaration was recorded.

The model is told when to call it by a `systemPrompt` section the same package registers: files a user is meant to receive — reports, tables, exports, images — are declared after they are written, with the path the model actually wrote and a sentence saying what the file is; drafts, temporary scripts, and extracted intermediate data are not declared. A turn that delivers nothing declares nothing.

### The declaration is folded into a projection, not computed at read time

`deliverables/presented` is a log-only event with no request-side consumer, so a declaration can never change what the model sees on its next step. Its reader is the `deliverables` session projection, registered by the same package: whole-value fold, one entry per turn, ordered by turn, deduplicated by resolved path within a turn, and bounded to the most recent `retainTurns` (default 50) turns. A path declared twice in one turn keeps its first declaration, so a description supplied later does not silently rewrite an earlier one.

The projection, not the log, is the read surface. Session projections ship with the tail page of `session.history`, so a consumer reading any turn of a session — the newest, or the tenth — pays one page fetch and receives the complete per-turn list. The read path never pages backwards, never scans for `turn/start`, and never inspects tool views.

### Turn attribution happens where the turn is open

The turn a declaration belongs to is resolved at append time by scanning the session's own event stream back to the nearest `turn/start` or `turn/end`, and is stored in the event payload. A later turn therefore cannot adopt an earlier declaration, and a reader cannot re-attribute one. `present` outside an open turn is rejected rather than recorded against an unknown turn.

### Paths are resolved, then translated by the consumer

`present` resolves each argument through the session's `FileSystem` service (`ctx.get('fs')`, optional: a host without a filesystem refuses the declaration instead of recording unverified paths) against the session working directory, and records the resulting display path — in the multi-tenant deployment an absolute path such as `/sessions/<session id>/report.md`. Requiring the path to exist as a regular file at declaration time keeps a typo from reaching the user as a dead link.

Translating that execution-world path into a consumer's own file vocabulary stays with the consumer. The host states what was delivered; it does not know that one deployment addresses those bytes as `session/<session id>/report.md`. A path the consumer cannot translate is reported as skipped rather than listed, which is what makes an ephemeral sandbox path safe to declare.

### The tool's render intent is a generic card

`present` reports a generic card with its raw input, so a transcript shows the declaration as an ordinary tool call. The declaration's product is the projection, not a bespoke transcript view; a dedicated card would duplicate a list the projection already carries.

## Alternatives considered

- **Keep deriving artifacts from tool traffic.** Rejected: the derivation guesses the model's intent from how a write happened to be rendered, so it counts drafts, misses command-produced files, and gives different lists to consumers that recognize different card kinds. The per-bubble page fetch is a symptom of the same design.
- **A convention directory as the marker.** Rejected: it turns a product convention into a fact the host must recognize by name, so a model that writes elsewhere delivers nothing and a model that writes a draft there delivers a draft. A declaration states intent directly and survives the file moving.
- **Declare in the assistant message text instead of a tool call.** Rejected: prose has no typed payload to fold, no `callId` to trace, and no way to reject a path that does not exist.
- **Compute the list in the host and expose a method.** Rejected: a second read surface for one fact, and it would redo turn attribution at read time, which is the paging problem again. Projections are the harness's existing mechanism for state derived from logged events.
- **Let `present` also write a user-visible summary into the conversation.** Rejected: model-visible output must be reconstructable on replay; the declaration is already durable, and duplicating it into the transcript would make the model answer twice for one action.
- **Bound the projection by bytes or by file count instead of by turn.** Rejected: the consumer renders per turn, so a byte budget would drop whole turns unpredictably. A turn bound is the unit the feature is defined in, and one turn's declarations are bounded by what the model writes.

## Consequences

- A turn's artifact list is exactly what the model declared: no inference, no directory convention, no per-consumer rules. A consumer that disagrees changes the guidance, which is deployment configuration, not host code.
- Nothing is delivered unless the model calls `present`. The tool guidance and a deployment persona carry that instruction; a session that never declares renders nothing.
- The projection retains the most recent `retainTurns` turns. A consumer reading a turn older than that boundary receives an empty list, and retention is bounded by turn, not by time.
- Declarations are per session. Two sessions delivering the same file each declare it; a consumer that cares deduplicates.
- `present` is a host-side tool with no client half. A client rendering the row reads the projection through its transport; the deployment's business API is one such consumer and lives outside this repository.
- The event type is a member of `KNOWN_SESSION_EVENT_TYPES`, so a build reading a log containing it interprets the log instead of refusing it.

### Verification

- `packages/deliverables/tool-present/tests/tool-present.spec.ts` covers the tool contract against a real session and filesystem: a declaration recording its turn, its files, and its resolved paths; resolution against the session working directory; rejection outside an open turn, of an empty list, and of a path that is not an existing regular file; deduplication within a turn; and the generic render intent.
- `packages/deliverables/tool-present/tests/projection.spec.ts` covers the fold: turn ordering, first declaration winning per path, the `retainTurns` bound, every other event returning the previous reference, and the projection reaching a `session.history` tail page.
- `pnpm run verify-persistence-catalog` and `pnpm run verify-package-invariants` gate the event vocabulary and the package's invariant companion; both compiler faces build the declaration merges.
- The business API in front of this repository is covered twice over: unit tests for the fold-to-list translation (including a verbatim tail page captured from the cluster) and a standalone-MVC contract test for the HTTP response the front end parses. Its live end-to-end test (`DshReportFlowLiveTest`, gated on `-Ddsh.live=true`) runs a real turn against a real tenant and asserts what a browser would see: one declared file with its description and turn, the notes file the model kept absent from the list, the declared path readable with an ETag, editable with `If-Match`, a stale ETag rejected with 412, a read-only scope refused with 403, and the session directory still listing both files for "show in folder".
- The tenant deployment is exercised end to end against a real model on the 130 test cluster: a turn writing a report and a draft and declaring only the report produces `deliverables` in the `session.history` tail page with the report's absolute session path and its description, no draft entry, and the same projection after the host restarts and rebuilds the session from its log.
