# Agent Note: The management plane installs published skills, the host only submits them

Status: implemented

English | [中文](2026-11-10-platform-owns-skill-install.zh.md)

## Problem

[Publishing a written skill from its directory](2026-11-10-skill-publish-from-files.md) shipped with two writers of "which skills this user has": `skill_publish` installed the directory into the host's user-global tier first, then told the platform, and the platform wrote its own record. The order made a false state reachable in both directions.

A publication whose platform hop failed left an installed skill the platform had never heard of: the model could trigger it, the user could not see it in 「我的技战法」, and nothing on the page could disable or delete it. The reverse was just as bad — the platform's own record carried a copy of the archive, so a later re-enable from the page installed bytes that might no longer match what the host had. Two writers, two truths, and the disagreement was invisible from both sides.

The platform was already able to do the whole job. Its `DshUserSkillInstaller` owns "write a skill into a subject's user-global tier", and its activation path (`updateStatus(id, 1)`) installs from the stored archive with `replace = true` and fails when the skill does not enter the host's catalog. The host-side install was not a capability the platform lacked; it was a duplicate of one the platform owns.

## Decision

**Only the platform installs.** `skill_publish` reads and validates the directory, zips it, and POSTs it to `POST /dsh/inner/skill/ingest`; it never writes a skill tier. Its own result is the platform's answer.

Consequences in the tool's contract:

- No `skillInstall` seam, no `tier` argument, and no `replace` argument: placement is the platform's decision (user-global, keyed by the submitting subject), and a submitted name replaces the earlier one as the platform's import already does.
- `record` is a **required** configuration field, not an optional extra. A deployment with no target refuses to load, because there is nothing it may install.
- A refusal now fails the whole call. Nothing was installed, so there is nothing to report as half-done: the result carries the platform's own explanation and says nothing was published.
- The submitting subject comes from `requireUser()` — the request's authenticated account — instead of being recovered from an installed directory's path.

The install seam lost the second entry point it gained for the first implementation: `installFromFiles`, `SkillInstallFilesRequest`, `SkillBundleFile`, and `readListed` are gone. Its tests and the package's bounds still cover the archive path it always had.

The document check stayed on the host, deliberately: `readSkillDocument` catches the failures the host's installer would reject later (no frontmatter, non-kebab-case `name`, empty `description`) in the conversation, where the model can fix them, instead of as a platform refusal after an archive upload.

## Alternatives considered

**Keep the host install and make the platform record mandatory.** This closes the first direction (no invisible skill) but keeps the second: the platform still holds its own copy and can install a different archive, and the two writes are still not one transaction. It also makes "record failed" a state where a skill exists that the user cannot manage — the exact complaint.

**Have the tool install and treat the platform as a read-through cache.** The platform's page is the only place a user can disable a skill, so the host cannot be authoritative about whether a skill is enabled. Any host-first design has to reconcile with the page anyway.

**Let the platform install but keep `tier` so a session can publish a system skill.** System skills are a deployment-level management action on 「系统技战法管理」; a tenant session must not be able to reach that tier. No `tier` means no way to ask for it, which is the enforcement the argument should be.

## Consequences

The host and the platform now agree by construction: the row, the archive, and the installed directory are all written by the platform's import and activation. The catalog the model reads and the page the user sees come from one record.

A failed publication is a clean failure — an unreachable platform, a rejected token, or a refused name leaves no skill behind. Publishing therefore costs a hop that must succeed, which is the coupling the previous design tried to avoid and should not have.

`skill-install` is back to one entry point (the archive), so `@deepseek-ai/dsh-tool-skill-publish` and `@deepseek-ai/dsh-skill-install` no longer share the files-to-directory path.

## Testing

`packages/skill/tool-skill-publish/tests/publish.spec.ts` drives the registered tool through `ctx.tools.execute` over the real filesystem and tool seams, against a stand-in ingestion endpoint that captures the request: the archive it bytes out (`SKILL.md` at the root, nested paths preserved, packaging noise skipped), the shared token, the subject taken from `runWithUser`, and the two form fields. It pins the walk's refusals (missing path, a file instead of a directory, no root document, an unloadable document, both bounds), the account check, and every platform outcome: a refusal envelope, a refusal carried only in `result`, a non-2xx status, a 2xx body that is not the envelope, a truncated body, an unreachable host, and a deadline that expires. A filesystem stand-in covers the three states a real one cannot produce on every platform (a non-regular entry, a file that grew past the bound after the listing, an unreadable file). Load-time refusals cover a missing target, an empty URL, both token forms set, neither set, an unset `tokenEnv`, and each non-positive bound.

`packages/skill/skill-install/tests/skill-install.spec.ts` keeps covering the archive path only: installation and its catalog refresh, wrapper stripping, path normalization, both refusals, replacement, and an aborted call that leaves the tier untouched.
