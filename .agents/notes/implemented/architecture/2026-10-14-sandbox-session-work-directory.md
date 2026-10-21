# Agent Note: Give every session its own work directory on the mounted case workspace

Status: implemented

English | [中文](2026-10-14-sandbox-session-work-directory.zh.md)

> Commands in a sandbox ran in the container-local `workDir` — an `emptyDir` shared by every session of one subject and discarded with the container — so two sessions of the same person competed for one directory, and a session's artifacts died with its sandbox.

## Problem

Both container providers create `workDir` as an `emptyDir` and make it the default working directory of the `tool-exec` container. A sandbox serves one `(tenant, subject)` pair and is reused across that subject's sessions, so that one directory belongs to all of them at once: concurrent sessions overwrite each other's artifacts, and nothing written there survives the container. A sandbox is replaced when its spec changes, when a node evicts it, and when its idle watchdog exits. The mounted case workspace at `/workspace` was already durable, but nothing told a session which directory inside it was that session's own: the report skills consulted `DSH_WORKDIR`, and no package in the repository defined that variable.

## Decision

- A session's commands run in `/sessions/<session id>`: one directory per session, under the mount that carries the subject's session directories, therefore on the claim rather than in the container.
- The provider creates it on that session's first command with `mkdir -p`, once per `(tenant, subject, session)`. The directory may already exist — another sandbox of the same subject, or an earlier host start — and `mkdir -p` is right either way. Because the workspace is a claim, a directory outlives the sandbox that created it.
- The session work directory overrides the working directory the caller asked for: the caller holds a path on the host it runs on, while the path inside the sandbox is decided by the mount table. An exec that carries no session keeps the caller's directory and with it the container default — this is how the provider's own probes and host tool calls behave.
- `DSH_WORKDIR` carries the same absolute path in that command's environment, so a skill and the model can name where they write instead of deriving it.
- The file surface resolves the same way: `dsh-fs-container` puts a relative path in the calling session's directory, overriding the `cwd` the caller passed. Commands took this override from the start, but file tools did not, so a session's `write`/`edit` landed in the container-local `workDir` — the shared, discarded directory this note exists to leave behind — while its commands wrote to the session directory. `sandboxSessionDirOf(session)` is the same derivation from a session id the file provider has directly, and without an ambient session the configured `root` stays in effect.
- The session id becomes a path component, so only a plain directory name is accepted; `sandboxSessionDir` rejects everything else, including a leading dash that would otherwise become an argument of `mkdir`. A rejected id leaves the command on the caller's directory rather than creating anything outside the workspace.
- `SANDBOX_WORKSPACE_MOUNT`, `SANDBOX_WORKDIR_ENV` and `sandboxSessionDir()` live in `@deepseek-ai/dsh-tenant` and both providers use them: the mount point has one name and the derivation has one implementation.

## Alternatives considered

- **Keep the container-local directory and have the session copy its artifacts out at the end.** Rejected: durability becomes a step the model must remember, and the copy is the step that fails when a sandbox is dying.
- **Put the session directories under a platform-owned name such as `sessions/`.** Rejected by the operator: one level of session directories directly under the workspace is what the case owner expects to see. Reversed later — [One file surface over the five scopes a subject's work lives in](2026-10-21-five-scope-file-surface.md) gives the session directories their own mount and their own name.
- **Create the directory when the session is created.** Rejected for now: the tenant host has no session-creation hook, so this needs a new tenant plugin, while the provider learns the session id from the environment of the first command — the same moment in effect.
- **Create it on the host filesystem instead of inside the sandbox.** Rejected: the provider's subject is the cluster, and the sandbox already owns `/workspace`.
- **Move the interactive terminal into the session directory as well.** Not taken: terminal sessions are not what this closed.

## Consequences

- Intermediate artifacts now persist by default. A session that wants throwaway space still has the container's own `/tmp`; nothing is deleted on its behalf.
- A session's relative file writes and its relative command paths name the same file, because both resolve in the session directory. Before the file surface followed the override they named two different files: the model could write a report with a file tool and then find its own `cat` of that path empty.
- Session directories now have their own mount: a subject's session directories are `<workspaceRoot>/users/<subject>/sessions/`, mounted at `/sessions`, so exposing the subject's work directory no longer exposes their sessions ([rationale](2026-10-21-five-scope-file-surface.md)).
- Each session leaves its directory behind, so `/workspace` grows one directory per session. Deciding when to clean them belongs to the business side, not to the provider.
- This reverses a documented decision: the container-k8s README stated that what a model writes by relative path must vanish with the sandbox. That is now the opposite of the accepted behavior, and this note is the record of the reversal.
- A session's first command pays one extra round trip for `mkdir -p`. The cost is per session, not per command.
- A session's interactive terminal keeps the container's default directory while that session's commands run in the session directory, so within one session the same relative path written through the terminal and through a command lands in two places. Relocating the terminal was not selected.
- A skill that pins the directory it writes to defeats the mechanism: the report skill shipped to the acceptance deployment instructed the model to `export DSH_WORKDIR=/workspace`, which overwrote the platform's value and put every session back into the shared root. It now leaves the variable alone and verifies the directory it resolved has the session's own name. Skill text is therefore part of this behavior's surface even though it ships outside the repository.
- Cross-links: the mount list this adds a layer under is [One `.dsh` root and one directory list for a tenant](2026-10-13-single-tenant-root-and-directory-list.md), and the bound that keeps a session's artifacts from taking a node down is [Bound the sandbox container's memory and CPU](2026-10-14-sandbox-resource-limits.md).

### Verification

- `packages/tenant/tenant/tests/layout.spec.ts` pins the derivation: a session id yields `/sessions/<id>`, an exec with no session yields none, and `../../etc`, `.`, `..`, `a/b`, the empty string, `session 7` and `-p` are all refused.
- `packages/tenant/container-k8s/tests/runtime.spec.ts` and `packages/tenant/container-docker/tests/docker.spec.ts` read the requests the provider actually sends: a session's first command is preceded by `mkdir -p /sessions/<id>`, the command carries that directory as `cwd` and the same value as `DSH_WORKDIR`, a second command in the same session creates nothing again, another session does, and an exec with no session keeps the caller's `cwd` and environment.
- `packages/tenant/fs-container/tests/container.spec.ts` resolves a relative path while an ambient session is in scope: it lands in `/sessions/<id>` even though the caller passed the container-local workDir, an absolute path stays absolute, and without an ambient session — none, a disposed registry, or an id that cannot be a directory name — the caller's `cwd` and then the configured `root` apply.
- 165 tests in the tenant, container-k8s and container-docker packages pass, and `pnpm run typecheck` is clean.