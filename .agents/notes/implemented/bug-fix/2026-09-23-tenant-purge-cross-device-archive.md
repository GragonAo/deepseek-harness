# Agent Note: Tenant purge archives across filesystems instead of reporting a move it never made

Status: implemented

English | [中文](2026-09-23-tenant-purge-cross-device-archive.zh.md)

## Problem

`tenant.admin.remove {purge: true}` promises to archive both of a tenant's host roots. Measured on the deployment host: after a purge, `/opt/dsh/.dsh/archive/<id>-<stamp>/` held only `data`, `/opt/dsh/tenants/<id>/workspace` was still in place with an unchanged mtime, and the API answered `{"removed": true}`.

`archiveDirs` moved each root with `fs.rename` and discarded every rejection through `.catch(() => { /* absent directory: nothing to archive */ })`. The archive root (`/opt/dsh/.dsh/archive`) and a tenant's roots (`/opt/dsh/tenants`) are separate bind-mount sources of the deployment, so they sit on different filesystems and `rename(2)` failed with `EXDEV: cross-device link not permitted` for the workspace. The handler read that failure as "there is nothing to archive". The data root shares a filesystem with the archive root, so its rename succeeded and the archive slot looked complete.

`mv` handles the same input because GNU `mv` degrades to copy-then-unlink when `rename` reports `EXDEV`; `rename(2)` has no such fallback, and a directory move across filesystems has no syscall that does.

The defect is the one the [sandbox mount-source preflight](2026-09-23-sandbox-mount-source-preflight.md) named from the other side: a real failure was reported as absence. The purge answered success while the case workspace stayed on the host, the disk was not released, and the directory "looked like it was still there" because it was.

## Decision

`archiveDirs` delegates each root to a new `moveIntoArchive(source, destination)`, and `moveIntoArchive` absorbs exactly one errno.

`ENOENT` is that errno. The slot's parent directory was created immediately before the move, so no other path component of either argument can be missing: `ENOENT` from this `rename` means the source directory is already gone, and a purge of a tenant whose directory no longer exists still archives what does. Every other code reaches the caller, because `remove` answers `{ removed: true }` only after `archiveDirs` returns — absorbing one reports a purge whose archive never happened, which is the defect this note records.

`EXDEV` is handled rather than propagated, because a cross-device move is this deployment's normal topology: the archive root and a tenant's roots are separate bind-mount sources by construction, so every purge of a workspace moves across filesystems. Propagating it would turn every purge into a failure and still leave the workspace on the host.

The move degrades to what `mv` does — a recursive copy followed by removal of the source:

```text
await fs.cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
await fs.rm(source, { recursive: true, force: true })
```

Each option is a deliberate choice about what an archive preserves.

- `recursive: true` is what makes the copy handle a directory tree at all; `fs.cp` refuses a directory without it.
- `preserveTimestamps: true` keeps every file's mtime and atime, so the archived tree still records when its contents were written rather than when the purge ran.
- `verbatimSymlinks: true` copies link text unchanged. The default resolves a relative target against the source tree and writes the absolute result, which would leave every relative symlink in the archive pointing at the directory the purge just removed.
- `fs.cp` restores each directory's and file's mode with an explicit `chmod` after creating it, so a restrictive umask cannot narrow the archived tree.

The source is removed only after the copy completes, so a copy that fails partway leaves the tenant's data where it was instead of destroying it. The copy is also the only step that can fail on a file type `fs.cp` refuses (a socket or a FIFO inside the tree); that failure reaches the caller rather than archiving a partial tree.

## Alternatives considered

- **Narrow the catch to `ENOENT` and keep the `rename` alone.** Rejected: it fixes the silence and not the outcome. Every purge on this deployment would fail on the workspace and leave it on the host, which is the state the operator is trying to end.
- **Propagate `EXDEV` and let the operator archive by hand.** Rejected for the same reason, with the failure moved into a runbook: the deployment's own compose file mounts the archive root and the tenant roots as different volumes, so the operator's every purge would need manual work, and a purge that fails after the partition drop leaves a registered tenant with no partition and a workspace still on disk.
- **Shell out to `mv`.** Rejected: the service is a plugin with no subprocess seam, and spawning a process to move a directory adds a failure mode (a missing or non-GNU `mv`) in exchange for behavior `fs.cp` and `fs.rm` already provide.
- **Move the archive root inside the tenants mount, so both sides share a filesystem.** Rejected as the fix: a deployment keeps archives on their own volume deliberately (retention, backup, and a disk that fills independently of the live tenants), and the existing `archiveRoot` fallback to `<dataRoot>/.archived` already covers the deployment that wants them together. Making one topology the precondition for a correct purge leaves the other one broken.
- **Copy unconditionally instead of renaming first.** Rejected: a same-filesystem rename is atomic and does not read or rewrite the data, and the two roots frequently do share a filesystem (the compose file's default archive root is a sibling of the tenant roots). Renaming stays the fast path, and the copy is the fallback that `EXDEV` selects.
- **Hand-roll the recursive copy.** Rejected: `fs.cp` is Node's supported implementation and already covers modes, timestamps, symlink handling, and the file types it refuses by name; a hand-rolled walk would own those decisions without owning any behavior this change needs.

## Consequences

- A purge archives a workspace that lives on another filesystem, so the archive slot holds both roots and the tenant's disk is released. A deployment whose roots already share a filesystem is unaffected: it still takes the rename path.
- A purge whose archive fails for any reason other than an absent source now fails the API call instead of answering `{ removed: true }`. The tenant record stays registered, and when the failure lands after the partition drop, that partition is gone while the directories remain — the non-transactional purge the package README records under its known limitations.
- The archive of a cross-device root is not atomic. A crash between the copy and the removal leaves both the archive and the original tree; the next purge of the same tenant would archive a second copy. Recovering that state is an operator decision, because only the operator knows whether the surviving original is the one to keep.
- The copy reads and writes every byte of the tenant's tree, so a purge of a large workspace takes proportionally longer than a rename and briefly needs room for both copies. The `tenant.admin.remove` request stays open for that duration.
- `fs.cp` refuses a socket or a FIFO anywhere in the tree, so a workspace containing one can no longer be purged until it is removed. This is a loud failure by design; the alternative is an archive that silently omits part of the tree.

## Testing

`packages/tenant/tenant-admin/tests/tenant-admin.spec.ts` covers the move at its four outcomes, driving the real filesystem and replacing only the `rename` syscall's result:

- A workspace whose `rename` reports `EXDEV` lands under `archiveRoot/<id>-<stamp>/workspace` with its file contents intact and is gone from its original path. Against the pre-fix source this test fails on the original path still existing, which is the defect reproduced.
- A `rename` that reports `EACCES` fails the `remove` call and leaves the record registered and the directory in place. Against the pre-fix source the call resolves `{ removed: true }`.
- A source directory that was already removed still purges the rest, so `ENOENT` stays the one absorbed code.
- The same-filesystem purge test now asserts both `data` and `workspace` are in the archive slot, not only that a slot exists.

14 tests pass in that file.
