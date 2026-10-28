# Agent Note: Terminal commands report the files they produce

Status: implemented

English | [中文](2026-10-27-terminal-produced-files.zh.md)

## Problem

A model that writes a `.docx` by running python-docx under `bash` never had its output recognized. The turn's produced-files row and the deployment's file statistics both read what a tool declares about itself: a mutation tool's `locations` on a diff or an `edit`-kind generic card. A file a command creates is named by none of those, so the run wrote the report to disk and every produced-files view stayed empty.

The information exists — the container knows what changed — but nothing carried it, because the bash tool's own result text is model-facing and a call presenter runs before execution.

## Decision

Four pieces, one channel:

- `@deepseek-ai/dsh-tools` presentation gains the field: `TerminalCallView` and `TerminalResultView` carry optional `produced: FileLocation[]`, meaning "this command created or modified these files", distinct from `locations`, which also covers what a command only read. A call-time presenter cannot observe execution, so a terminal call view normally omits it; the completed result view carries what the run wrote.
- `@deepseek-ai/dsh-subprocess-container` observes write effects on the container's own clock. Before a session-scoped command it creates a marker (`/tmp/.dsh-produce-<uuid>`); after the command settles one bounded `sh -c` lists the regular files under the session directory newer than that marker and removes the marker. `SubprocessOutcome.produced` carries the paths in the executor's own vocabulary, and `ShellRunResult.produced` re-exports them.
- `@deepseek-ai/dsh-tool-bash` puts them on the card: `presentationMeta` projects `{ produced: [{ path }] }` onto the persisted `tool/result` metadata, and `presentResult` narrows it back, so the terminal card carries the paths live and on replay.
- `@deepseek-ai/dsh-client-ui-deliverables` folds the produced files of a successful call into `DeliverablesTurnData`, the same standing a diff card has, deduped in first-seen order.

The negative clauses are part of the decision. A failed call contributes nothing. A command the provider cannot attribute to a session (no `DSH_SESSION_ID` in its managed environment) is not observed at all, so host probes and executable lookups pay nothing. Observation failure — an unreachable container, a marker that could not be created, a scan that exited nonzero or timed out — degrades to "no produced" and never fails the command. Paths keep the container-absolute `/sessions/<id>/…` spelling that `@deepseek-ai/dsh-fs-container`'s `displayPath` already produces, so one path means the same file in both capabilities.

Model-facing text, tool parameters, and the executor's result rendering are unchanged: the file list reaches only the terminal card.

## Alternatives considered

- **Walk the host's copy of the session directory after the command**: rejected — the session directory may live on a substrate the host cannot read, and a host-clock `-newer` comparison against a container-written file mixes two clocks.
- **Read the written paths out of the command line or its stdout**: rejected — `python make.py` names nothing it writes, and watching output for file names guesses.
- **Wrap the command in a tracing layer** (`strace`, fanotify, a shell `PROMPT_COMMAND`): rejected — unavailable or privileged in these container substrates, and a wrapper changes the command the model asked to run.
- **Persist produced paths as a session event**: rejected — the list is presentation, it recomputes from `tool/result` metadata on replay, and a new event would grow every log for a UI row.
- **List the files in the model-facing result text**: rejected — that would change every bash call's context and KV-cache stability to serve the UI.
- **Report the same from `dsh-tool-bash-persistent`**: deferred — a persisted shell has no per-command settlement, so there is no moment at which one command's writes are known.

## Consequences

- A turn that generates a document by command lists it, so the produced-files row and the file statistics agree with the disk.
- Each session-scoped foreground command costs two extra `containerRuntime.exec` calls: a `touch` before it and one `sh -c` (find plus marker removal) after it. A background start pays both and discards the report, because a start has no settlement point to attach it to.
- The scan covers the session directory only, and `-newer` compares against the filesystem's timestamp granularity: on a coarse-granularity volume a rewrite landing in the same granule as the marker can be missed. `emptyDir`-backed session storage is the common case for those deployments.
- Executors that observe no write effects — the local and pwsh executors — report nothing, so what the row lists depends on the executor the deployment composed.
- `presentationMeta` cannot return `undefined` (a projection must be lossless JSON), so `createSuccessResult` now drops a projection with no members instead of persisting `meta: {}`. A tool that has no presentation fact for a result states `{}`, and every logged result without produced metadata stays byte-identical.

## Testing

`packages/tenant/subprocess-container/tests/container.spec.ts` proves the observation: a session-scoped command reports exactly what the scan lists; a marker that could not be created or reached disables the report without running a scan; a scan that rejects or exits nonzero reports nothing; a capped scan drops its partial first line; a command without a session identity runs no observation exec at all; and an exec failure still settles the scan (to remove the marker) and rejects with the original error. `packages/shell/tool-bash/tests/tools.spec.ts` proves the canonical value, the persisted metadata, and the card the presenter rebuilds, plus that an executor reporting no writes adds no `produced` field anywhere. `packages/client/ui-deliverables/tests/produced-files.client.spec.tsx` proves the fold: a successful terminal call contributes its produced paths once each in first-seen order across both card states, a failed call contributes nothing, and a command that wrote nothing adds no entry. `packages/core/tools/tests/tools.spec.ts` proves a memberless projection persists no `meta`.