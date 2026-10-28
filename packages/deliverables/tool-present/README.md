# @deepseek-ai/dsh-tool-present

English | [中文](README.zh.md)

The model-facing `present` tool: the files one turn hands to the user.

## What it does

Registers one tool, `present(files: [{ path, description? }])`, on `ctx.tools`. Each call appends a `deliverables/presented` event — the turn, the `callId`, and the declared files — to the calling agent's session log.

The declaration is the only source of "what this turn delivered". A file the turn merely wrote, a draft, an extracted intermediate, or a helper script is absent from that list unless the model presented it, so a client renders what the turn decided to hand over rather than every path the turn touched.

`present` is rejected outside a running turn: the turn is attributed from the log's own boundary when the event is appended, so a declaration can never be adopted by a later turn.

## Validation

`execute` resolves every `path` through the composed filesystem (`ctx.get('fs')`) against the session working directory and requires an existing regular file; the recorded path is the backend's display path, an absolute path in the execution world. Duplicate resolutions of the same path, blank paths, and blank `description` values are rejected before the event is appended. A headless composition without a filesystem records the path as the model wrote it and checks nothing — the declaration is still durable, only unverified.

Stable failures: `Error: present: every entry needs a non-empty \`path\``, `Error: present: "<path>" does not exist — declare the files this task actually wrote`, `Error: present: "<path>" is a <type>, not a file`, `Error: present: "<path>" is declared twice`, `Error: present requires an owning agent session`, `Error: present must be called while a turn is running`.

## Configuration

`retainTurns` (default `50`) bounds the projection: only the most recent `retainTurns` presenting turns stay in the projected state, so a long session does not ship unbounded per-turn lists to a client on every delivery. The session log keeps every declaration, so a reader that scans history still finds older turns.

## Session projection

When the composition mounts `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)), this package registers the `deliverables` unit under an injected child: `init` = `{ turns: [] }`, `apply` = fold each `deliverables/presented` into the whole state (that turn's entry gains the new paths at first declaration, turns stay ordered by turn, the tail is trimmed to `retainTurns`; every other event returns the same state reference), `view` = identity, `stateVersion` = 1. The key merges into `SessionProjectionMap` in `src/types.ts`; carriers serve the value on the history tail page and the `session/projection` push frame.

## Rendering

The canonical result is `{ turn, files }`. The call card is a generic card titled `Present deliverables` carrying the declared files as raw input; the model-facing result lists each declared path with its description.

## Export shape

A function plugin: it exports `name` / `inject` / `Config` / `apply` and NO default (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The generated [`present` schema](../../../docs/tool-catalog.md) plus one system-prompt section instructing the model to present finished deliverables only — never drafts, intermediate data, or helper scripts.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call retains its declared paths and descriptions in the assistant tool-call arguments. Success returns the turn number and the declared files, one `- <path> — <description>` line each. The `deliverables/presented` event is durable UI and replay state, not a second model message.

#### Token effect

Token growth scales with the number of files a turn presents; the result repeats the paths once.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Declaration-only identification** — nothing cross-checks a presented file against the writes of the same turn; the filesystem check at declaration time (existence, regular file) is the boundary. A turn that presents a file it did not write in that turn is possible and is treated as the model's statement about the deliverable.
- **No client half** — the package registers no browser entry; the tenant deployment serves the projection through its business surface, and the harness web client does not render it.
- **Retention is per deployment** — `retainTurns` trims the projected state only; there is no compaction of the underlying declarations.
