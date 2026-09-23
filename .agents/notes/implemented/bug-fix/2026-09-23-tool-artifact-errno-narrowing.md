# Agent Note: The artifact tools absorb only ENOENT, never a filesystem failure as absence

Status: implemented

English | [中文](2026-09-23-tool-artifact-errno-narrowing.zh.md)

## Problem

`@deepseek-ai/dsh-tool-artifact` answered three filesystem failures with conclusions the model could not tell from the truth. `resolveSource` rewrote every rejection from `realpath` as `file_path "/workspace/report.docx" does not exist`, so a path the host refused to read — `EACCES`, `ELOOP`, `ENAMETOOLONG` — was answered with `does not exist`. `listPublished` read the subject's library through `readdir(...).catch(() => [])` and examined each entry through `stat(...).catch(() => undefined)`, so a library directory that could not be read answered `Nothing has been delivered to this user yet.`, and an entry that could not be examined disappeared from a list the model reads as the whole one.

This is the defect the [tenant purge](2026-09-23-tenant-purge-cross-device-archive.md) and the [sandbox mount-source preflight](2026-09-23-sandbox-mount-source-preflight.md) name from their own sides: a real failure reported as a specific, wrong conclusion, against the rule that a missing referent is never silently skipped and a failure fails loud. The purge reported "nothing to archive" and kept a tenant's workspace on disk; the preflight reported nothing at all and mounted an empty directory. Here the conclusions are "the file does not exist" and "you have delivered nothing" — and the reader is the model, which repeats them to the user as fact.

Absence and a failed read are different answers, and the difference reaches the model as different text: `entries: []` renders as `Nothing has been delivered to this user yet.`, while a short list renders as a count of delivered files with one line per entry. A model that is told "nothing" reports an empty library to the user; a model that is told "one file" and would have been told "two" reports a complete library that is missing one.

## Decision

One predicate, `isENOENT`, and one absorbed code per site, each with the reachability argument that makes it the only thing that code can mean there.

**`resolveSource`.** `candidate` is the mount root — already resolved above, so it exists — joined with the model's own path, so nothing about it is unknown except whether that path is there: `ENOENT` is absence, and it keeps the message that names the container path. Every other code reaches the caller unchanged, keeping its errno, its message, and the syscall that failed. The mount root's own `realpath` already propagated raw; the two calls are now symmetric.

**`listPublished`'s `readdir`.** The subject's library directory does not exist until its first publish — a normal initial state rather than a failure — and a subdirectory named by the `readdir` that listed it a moment earlier can be gone before the recursion reaches it. `ENOENT` is an empty list at both. `EACCES`, `EIO`, and `ENOTDIR` mean the read failed for some reason other than absence and reach the caller.

**`listPublished`'s `stat`.** The name came from that directory's own `readdir`, so the entry existed a moment earlier: `ENOENT` is a concurrent removal, and skipping a file that is no longer there is accurate. Every other code reaches the caller, because dropping the entry would shorten the list without saying so.

**`publishInto`'s `finally`.** The best-effort removal of the staging file keeps its catch, with the reason recorded in code: the success path renamed `staging` to `destination`, so `ENOENT` is what a published artifact normally reports here, and any other code leaves at most a dot-prefixed `.part` file that no reader opens and no listing reports. Cleanup cannot report a failure as a success — the `try` propagates its own error first — while letting a cleanup failure out of a `finally` would replace a returned destination with an error, reporting a delivered artifact as an undelivered one.

The module reaches its filesystem calls as `fs.realpath(...)` on `import { promises as fs } from 'node:fs'` rather than through named imports of `node:fs/promises`. Node's ESM facade for a builtin snapshots its named exports, so `vi.spyOn` on `node:fs/promises` never reaches a module that imports them by name, and the errno seam these tests need would be unreachable. `dsh-tenant-admin` reads its filesystem the same way.

## Alternatives considered

- **Delete the catches, so `ENOENT` propagates too.** Rejected: absence is the normal state at each of the three sites — a subject with no deliveries has no directory, and a staging file that was successfully renamed is gone. Propagating it would fail correct calls.
- **Keep the catch-alls and report the failure somewhere else.** Rejected: this plugin has no logger, and its only channel to the model is the tool result. A warning nobody reads leaves the wrong conclusion in place, which is the defect rather than a mitigation of it.
- **Wrap a non-`ENOENT` failure in a message naming the container path.** Rejected: the wrapper would have to embed the original message to stay useful, so the host path it was meant to hide arrives anyway, and wrapping costs the original error object and its `code`. Propagating the raw error is what `dsh-tenant-admin`'s `moveIntoArchive` does with the codes it does not absorb.
- **Treat `ENOTDIR` as absence as well.** Rejected: a path component that is not a directory is not an absent path. On the `readdir` site it means the subject's own library path is now a file — a state an operator has to see — and on the `resolveSource` site it means the model addressed a file as a directory, which the failure states exactly.
- **Return the partial list with a count of what it skipped.** Rejected: the model cannot check a number whose meaning is "entries this deployment could not examine", so it would report a count it has no reason to doubt. The tool's answer is what this subject delivered, and a list that is not that answer fails instead.
- **Narrow the cleanup catch to `ENOENT` and propagate the rest.** Rejected: a throw from the `finally` replaces the destination the publish already returned, so a call that delivered a file would answer with an error and no delivery tag — a success reported as a failure, which is the same class of wrong conclusion from the other direction.

## Consequences

- A deployment whose library directory is unreadable now fails `artifact_list` instead of reporting an empty library, and one whose entry cannot be examined fails it instead of reporting a shorter list. On a readable library nothing changes.
- A publish whose source the host refuses to resolve now fails with the raw Node error, which names the host path and the failing syscall. That is deployment layout the model did not otherwise see; it cannot act on it, and the alternative cost the errno and the error object.
- A cleanup failure leaves a `.<stamp>.<uuid>.part` file in the library directory. No listing reports it, because `artifact_list` skips dot-prefixed names, and no reader can reach it, because nothing references it; it consumes disk until an operator removes it.
- The publish and list tools now distinguish "nothing published" from "could not read", so a deployment failure surfaces to the user through the model instead of as an empty library.

## Testing

`packages/tenant/tool-artifact/tests/artifact-tools.spec.ts` boots the plugin over a real temporary deployment — `ToolRuntime`, the subject's `/workspace` mount, and the authenticated (case, subject) scope — and replaces one syscall at a time by spying on `node:fs`'s promise object. 9 tests pass.

- A `realpath` that reports `EACCES` for the source file fails the publish with `EACCES` in the result and no `does not exist`. Against the pre-fix source the same test receives `Error: file_path "/workspace/report.docx" does not exist` — the defect verbatim.
- A `readdir` that reports `EACCES` for the library directory fails `artifact_list`; against the pre-fix source the same call resolves `isError: false` with `entries: []`, which renders as `Nothing has been delivered to this user yet.`.
- A `stat` that reports `EACCES` for one published entry fails `artifact_list`; against the pre-fix source the same call resolves `isError: false` with the entry silently dropped.
- A `stat` that reports `ENOENT` for one published entry still skips it, and a library that does not exist yet is still an empty list: the two absorbed codes are pinned as absorbed, so the reachability arguments above are executed rather than asserted.
- An `unlink` that reports `EACCES` for the staging file still delivers the artifact: the publish resolves with its path and delivery tag. The rejected alternative is measured the same way — replacing the cleanup's catch with a bare `await fs.unlink(staging)` fails this test, which is a delivered artifact reported as an undelivered one.
- `packages/tenant/tool-artifact/tests/artifact-store.spec.ts` keeps its 18 tests; 27 pass in the package.
- `tsc -b tsconfig.host.json` is clean, and that program includes `packages/*/*/tests/**/*.ts`, so the new suite is type-checked.

`src/index.ts` had no test of its own before this change; it now measures 83.87% statements and 61.76% branches, still below the repository's per-file 100% coverage bar. The remaining uncovered lines are the mount-escape refusal (which needs a symlink the local Windows host refuses to create), the delivery-name exhaustion loop, and the over-limit and paginated-render branches. That gap is not closed here.

## Related

- [Tenant purge archives across filesystems instead of reporting a move it never made](2026-09-23-tenant-purge-cross-device-archive.md) — the same defect on the archive path, where a swallowed `EXDEV` was read as an absent directory.
- [Sandbox bind-mount sources are provisioned and checked before the container starts](2026-09-23-sandbox-mount-source-preflight.md) — the missing-referent side of the same family.
