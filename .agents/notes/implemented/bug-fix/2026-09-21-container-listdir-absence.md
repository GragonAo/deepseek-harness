# Agent Note: Container directory listing reports absence as absence

Status: implemented

English | [中文](2026-09-21-container-listdir-absence.zh.md)

## Problem

`FileSystem.listDir` distinguishes an absent directory from an unreadable one: `dsh-fs-local` throws `FS_NOT_FOUND` when the target does not exist and `FS_NOT_DIRECTORY` when it exists as a non-directory, and callers rely on that distinction. Discovery code treats a missing skill or tool root as an empty root — the multi-tenant skill provider's own absent-root path accepts `FS_NOT_FOUND` through `isAbsentSkillPathError` — and treats any other code as a real failure.

`dsh-fs-container` implements `listDir` over `find` through the container runtime and classified every non-zero exit as `FS_IO_ERROR`. `find` reports a missing directory on stderr with a non-zero exit, so on the multi-tenant deployment a missing default skill root (`/workspace/.dsh/skills`) surfaced as an I/O failure rather than as absence. The error escaped the provider's `list`, the skill registry caught it, and the registry dropped the **entire provider** — discarding the ambient tier skills it had already discovered alongside the one broken root. The catalog came back empty with no skill error anywhere in the response.

## Decision

`listDir` classifies the two distinguishing `find` diagnostics before its fallback, matching the `readError` and `stat` paths in the same file:

- `No such file` → `FS_NOT_FOUND`
- `Not a directory` → `FS_NOT_DIRECTORY`
- anything else → `FS_IO_ERROR`

The absent-directory classification is the contract `dsh-fs` states for `listDir` in the abstract method's JSDoc, which now names all three codes and records that callers depend on the distinction. `dsh-fs-container` is brought into line with it; no consumer changes.

## Alternatives considered

- **Accept both codes in `isAbsentSkillPathError`.** Widening the caller to tolerate `FS_IO_ERROR` as absence would also swallow genuine read failures, and it would leave every other `listDir` consumer — tool discovery included — treating a missing root as a broken one. Chosen: fix the provider that is out of contract.
- **Probe with `stat` before listing.** Adds a round trip per listing to recover information `find` already reports, and races with a directory removed between the probe and the listing.
- **Return an empty listing for any non-zero exit.** Discards the error for a permission failure or an unreachable runtime, so a genuinely broken root becomes indistinguishable from an empty one.

## Consequences

**Bought:** absence, non-directory, and I/O failure are distinguishable through the container backend exactly as through the local one, so a missing root costs only its own candidates. On the multi-tenant deployment the ambient case, user-global, and system skill tiers now reach the catalog.

**Cost and deferred work:** the classification reads `find`'s English stderr text, which `dsh-fs-local` shares as a limitation — it is the same contract the sibling backend already relies on, not a new dependency. The weakness this exposed — the skill registry dropping an entire provider, and with it the candidates already discovered, when one root throws — is fixed in the same change: the provider now contains a failed root, logs it, and reports an incomplete observation, as [the catalog-refresh note](../feature/2026-07-27-skill-catalog-hot-refresh.md) already required of watch failures.

### Verification

Three `fs-container` tests in `packages/tenant/fs-container/tests/container.spec.ts` mount a listing whose stderr carries one diagnostic each and assert `FS_NOT_FOUND`, `FS_NOT_DIRECTORY`, and `FS_IO_ERROR` respectively; the first fails without the classification and the suite passes 9/9 with it. `packages/fs/fs-local/tests/filesystem.spec.ts` and `fsio.spec.ts` already assert the same two distinguishing codes for the local backend, which is the contract the container backend now matches.
