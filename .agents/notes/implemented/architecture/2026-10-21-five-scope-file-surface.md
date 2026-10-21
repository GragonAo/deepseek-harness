# Agent Note: One file surface over the five scopes a subject's work lives in

Status: implemented

English | [中文](2026-10-21-five-scope-file-surface.zh.md)

> A business module that wants to show, open, and edit a file the harness produced had to grow a harness API method for it, and the directories those methods reached named the case tier and the case work directory with one word while nesting every session inside the subject's work directory.

## Problem

The business layer above the harness produces and edits documents the agent also works on: a report written by a skill, a contract template a case member uploads, a case's shared inputs. Each such module arrived with its own harness method — read this artifact's bytes, write that template back — so the harness grew one endpoint per business object, and the business layer learned where the harness keeps its directories (a Ceph path, a mount point, a session directory name). Both are wrong owners: the harness owns where a subject's files live, and a business module should need no more than a file address.

The on-disk layout made that address impossible to state. `<workspaceRoot>/shared/` held the case's work directory and the case's `config`/`skills`/`tools` tiers side by side, so one name meant two different things. Every session directory sat inside the subject's work directory, so exposing that work directory — the only directory a case member obviously owns — exposed every session of that member as well.

## Decision

Five scopes, each one host directory, each one sandbox mount, and one HTTP surface over all five:

| scope | host directory | sandbox | writable |
|---|---|---|---|
| `session` | `<workspaceRoot>/users/<subject>/sessions/<sessionId>` | `/sessions/<sessionId>` | yes |
| `user` | `<workspaceRoot>/users/<subject>/work` | `/workspace` | yes |
| `case` | `<workspaceRoot>/work` | `/case` | no |
| `global` | `<usersRoot>/<subject>/work` | `/global` | no |
| `system` | `<systemRoot>` | `<systemRoot>`, same path | no |

- Work directories are named `work/` and are leaves: a work directory is never an ancestor of a tier directory or of another subject's, so mounting one reveals nothing but files.
- The case tier directories are `<workspaceRoot>/{config,skills,tools}`, siblings of `work/`. The sandbox mount point for the case work directory is `/case`, and the read-only flag is `caseReadOnly`; both names now say which directory they mean.
- Session directories live under their own `<workspaceRoot>/users/<subject>/sessions/<sessionId>`, mounted at `/sessions` with `/sessions/<sessionId>` as the session's working directory. The subject's work directory and their session directories are separate mounts, so neither widens the other.
- `@deepseek-ai/dsh-tenant-fs-http` serves `GET`, `HEAD`, and `PUT` on `/<prefix>/<scope>/<path>`, plus a directory listing at `/<prefix>/<scope>?path=<dir>`. It owns no state: the filesystem is the record, so the model's next read of a path sees what the business client just wrote.
- Every version carries an ETag derived from size and nanosecond modification time. `If-Match` makes a write conditional (a concurrent writer gets `412` and re-reads), `If-None-Match` answers `304`, and a write lands through a temporary file renamed into place.
- The three read-only scopes answer `403` to a write rather than failing quietly: the case and global work directories are the business layer's to write, and the system tree is the operator's. The `writable` column above describes what this surface accepts; whether the sandbox may write `/case` or `/global` is the separate `caseReadOnly`/`usersReadOnly` decision.
- Path resolution confines twice. Segments that are `.`, `..`, empty, or hold a separator are refused before any filesystem call, and the root plus the nearest existing ancestor of the target are resolved through `realpath`, so a symlink planted inside a writable scope cannot reach outside it.
- A `session` path names its session in the first segment, and the surface refuses to write into a session directory that does not exist: sessions are created by the session lifecycle, not by a file write.
- The route is mounted by `tenant-app` as a static row and probed by its startup assertion, so a deployment that lost it fails loud instead of serving `404` on a surface the business layer depends on.
- The `node:http` ↔ fetch adapter the route answers through is one implementation in `@deepseek-ai/dsh-host-webserver` (`bridgeFetchRequest`), so the carriers that serve HTTP — this surface, the tenant `/api` carrier, and the browser connection's host half — share one body cap, one backpressure path, and one client-disconnect abort instead of holding three copies of them.

## Alternatives considered

- **Keep one harness method per business object.** Rejected: it is the coupling this removes. A new module would add a method, a DTO, and a test to the harness before it could show a single file, and the harness would keep knowing about report tables and template rows.
- **Operate inside the tenant container instead of on host directories.** Rejected: it makes reading a file depend on a running sandbox, so a stopped sandbox hides a durable file, and it puts the business request on the container's request path. The host already sees the same bytes through the same mount source.
- **Expose only the writable scopes.** Rejected: the case tier and the system tree are exactly what a report or a template reads. Read-only access with an explicit refusal on write is the smaller surface.
- **Derive the ETag from a content digest.** Rejected: it answers the same question at the cost of reading every file twice on every `GET`. Size and nanosecond modification time change on every write, which is the property a precondition needs.
- **Let the surface create a session directory on demand.** Rejected: a file write would mint a session, and the session's own lifecycle would then find a directory it did not create.
- **Serve the work directories only, and let each module keep its own route for the rest.** Rejected: five scopes addressed by one prefix is what makes the business side generic. A new module adds no route.
- **Take the file bytes through `ctx.fs`.** Not possible: that seam writes text, and reports are binary documents. The surface uses `node:fs` behind its own confinement, which is why the confinement is stated above rather than inherited.

## Consequences

- A business module now stores a scope and a relative path, not a host path: `user/reports/2026-10.md`, not a Ceph location. Nothing above the harness knows a mount point or a tenant root.
- This reverses the placement recorded in [Give every session its own work directory on the mounted case workspace](2026-10-14-sandbox-session-work-directory.md): a session's directory is `/sessions/<sessionId>` under its own mount, and the alternative that note rejected — session directories under a platform-owned name — is the one now shipped. That note's refusal of a session directory inside `/workspace` stands; only the mount it names changed.
- The layout half of this note fixes the directory names in [One `.dsh` root and one directory list for a tenant](2026-10-13-single-tenant-root-and-directory-list.md), which now lists `work/` and `sessions/` where it listed `shared/` and per-session directories.
- A deployment migrates twice: rename `sandbox.sharedReadOnly` to `sandbox.caseReadOnly`, and move `shared/{config,skills,tools}` up one level, `shared/` to `work/`, and `users/<subject>/<sessionId>` to `users/<subject>/sessions/<sessionId>`.
- The publisher reads the same table: `object_publish` maps `/workspace`, `/sessions`, `/case`, and `/global` to the work and session directories this layout gives them, so a file the model wrote in its own session directory is publishable without being copied first, and a relative path resolves against that session directory.
- Concurrency is conditional, not exclusive: two clients may both read a version and both write. The second write loses with `412` and must re-read, so a client that ignores `412` loses an edit. Nothing in the harness serializes edits to a file the model is also writing.
- Byte transfer is capped by `maxBytes` (64 MiB by default), which bounds the write and the buffered bridge body together. A report larger than that has no upload path through this surface yet.
- No audit trail, no per-subject quota, and no delete: a file the business layer no longer wants stays until someone with host access removes it.
- A business client can now change a file while the model is mid-turn, and the model's next read sees the change. That is the point, and it also means a turn's cached assumption about a file can be stale within one turn.
- Cross-links: the layout half of this note is the directory list [One `.dsh` root and one directory list for a tenant](2026-10-13-single-tenant-root-and-directory-list.md), the surface is one row of the composition in [Multi-tenant slice](2026-08-24-multi-tenant-slice.md), and the session placement it reverses is [Give every session its own work directory on the mounted case workspace](2026-10-14-sandbox-session-work-directory.md).

### Verification

- `packages/tenant/fs-http/tests/roots.spec.ts` pins the scope table and the two confinement layers: an unknown scope, an unconfigured one as `503`, a missing root, every unsafe segment, an undecodable escape, and a symlink resolving outside the root.
- `packages/tenant/fs-http/tests/fs-http.spec.ts` reads one file from each scope, answers `HEAD` and `304`, writes a file the next read sees, refuses a stale `If-Match` with `412` and leaves the winning bytes in place, refuses writes into all three read-only scopes, lists a directory with an ETag per file, refuses a session directory that does not exist, answers `409` for the wrong entry kind, keeps a traversal attempt inside the root, answers `405` and `413`, fails closed without a tenant-scoped credential and for a non-member, and round-trips the same surface over a real `webServer`.
- `packages/host/webserver/tests/fetch-bridge.spec.ts` pins the shared adapter: `413` from a declared length before dispatch, `413` from a body that crosses the cap while streaming, header copy with a body, a null body, a streamed body that waits for `drain`, no abort after a normal end, and an abort the handler observes when the client goes away.
- `packages/tenant/object-store/tests/object-publish.spec.ts` publishes from `/workspace`, `/sessions`, `/case`, and `/global`, and pins that a relative path resolves against the session's own directory.
- 508 tests pass in `packages/tenant` (37 files, including the 24 above) and `pnpm run typecheck` is clean.