# Agent Note: Skill writes take their tier from the request, not from the payload

Status: implemented

English | [中文](2026-10-23-skill-tier-writes-from-request-scope.zh.md)

> A skill bundle is addressed by which directory it lands in, and that directory is a property of the caller. A management surface that lets the caller name the tier is a surface that lets a tenant write the deployment's system skills.

## Problem

Skills live in three tiers — `case`, `user-global`, `system` — and `@deepseek-ai/dsh-skill-tier` resolves each root from the ambient request scope: the case workspace, the user's own directory under `usersRoot`, or the deployment's system directory. Until now only the tier-aware listing existed as a business-face method (`skill.list`, the merged catalog a session can invoke), so a person who wanted to add or delete a skill had to be handed a host directory. The management flow that did exist lived outside the harness, in the business layer's scheduler bridge, which called a service the harness no longer runs.

The harness therefore needs a write surface for skill bundles. The two requirements pull in opposite directions: a case member must be able to install a skill (that is the whole point), and a case member must not be able to write a skill every case in the deployment then runs. The address of the write is what decides that, and the address is derived from who is asking.

There is a second gap. A skill bundle is an archive a person prepares by hand, so it is wrong in ordinary ways: the `SKILL.md` sits two directories down, the frontmatter is malformed, a symlink points at `/etc`, the archive carries half a gigabyte of files. The old flow installed whatever it was given, which turned a bad archive into a broken tool list discovered later, mid-conversation.

## Decision

Three business-face methods — `skill.install`, `skill.remove`, `skill.installed` — and no tier field on any of them.

- The payload of `skill.install` is `{zip, replace?}`, `skill.remove` is `{name}`, `skill.installed` is empty. The operation calls `ctx.skillInstall` with the fixed tier `user-global`. Its directory resolves from the request's own tenant and user scope through `runWithTenant`/`runWithUser`, so the caller's identity is the address.
- A tier field would be a way to name a directory the caller must not reach, so it does not exist. The system tier is written only by the admin surface (`skills.list`, `skills.upload`, `skills.remove` on the tenant admin HTTP face), which authenticates with an admin token instead of a tenant request.
- Both surfaces share one validation seam, `@deepseek-ai/dsh-skill-install`. It accepts a bundle only when the archive holds exactly one `SKILL.md` at its root or inside a single wrapper directory, has no entry whose resolved path escapes the target (absolute paths, `..` segments, symlinks), stays under 16 MiB packed, 64 MiB expanded and 2048 entries, and yields a loadable frontmatter document. A bundle that fails is refused whole: no partial directory is left behind.
- An install and a removal replace the skill's directory by a single rename and then call `ctx.skills.refresh()`. `install` answers `{name, directory, replaced, files, visible}`; `visible` is whether the entry is in the invocation catalog immediately after that refresh, which is how a caller learns that a syntactically fine bundle still does not load at this deployment.
- `skill.installed` answers the tier-scoped management listing — `{directory, entries[{entry, name?, description?, loadable, issues[]}]}` — including entries that cannot load, each with coded `{code, message, line?}` document issues. `skill.list` keeps its own question: the merged catalog the session can invoke.
- On the business face every refusal is one error, `skill-rejected`, carrying `details.reason` (the seam's own code) and `details.issues`. The status an HTTP carrier derives comes from the seam code group: `skill-exists` and `skill-ambiguous` → 409, `skill-absent` → 404, `bundle-invalid` and `bundle-unsafe-entry` → 400, `bundle-too-large` → 413, `tier-unavailable` → 503. The admin surface answers those codes directly, since it forwards to the seam without a business envelope in between.

## Alternatives considered

- **Put `tier` in the payload and validate it against the caller.** Rejected: the enforcement then lives beside the operation instead of in it, and every future caller has to repeat it. The absence of the field is the enforcement.
- **One method family for both callers, with the admin path selected by token scope.** Rejected: a tenant-derived scope would have to decide what a system-tier request means, and that decision is exactly what the two surfaces already separate.
- **Accept the bundle as multipart on the wire.** Rejected: the business carrier is one JSON envelope (`client-request`) shared by every method; a second body encoding would exist only for these two calls. The business layer that has the file encodes it.
- **Reuse `skill.list` as the management listing.** Rejected: the merged catalog answers which skills a session may call, and by construction hides the ones that failed to load. A management screen needs the opposite answer.
- **Validate the bundle in the business layer before calling the seam.** Rejected: the admin surface calls the seam too, so the rules would exist twice and drift.
- **Mirror every seam code into the business face** (`skill-exists`, `skill-absent`, …). Rejected: those codes name seam conditions, and a client that branches on them couples to the installation package. One wire code plus `details.reason` keeps the business face closed over its own vocabulary while leaving the cause visible.
- **Report a successful install without checking the catalog.** Rejected: a bundle can be installed and still not load (a duplicate name already claimed by another tier, a tool its frontmatter asks for that this deployment lacks). Without `visible` the caller's only evidence would be a later listing.

## Consequences

- A case member can install, list and delete skills in their own user-global directory, and no request payload can reach the case tier, the system tier, or another user's directory.
- Case-level skills remain unexposed: no method writes a case's `skills/` directory, so a case's skill set stays the case owner's on-disk responsibility.
- System skills are reachable only through the admin face, which means a deployment that mounts no admin surface has no way to change them at runtime — system skills are then a packaging decision, not a runtime one.
- A deployment that mounts no `skill-install` reports the absence per call (`internal: skill installation is absent`) rather than failing at startup, so a harness without skill management keeps working.
- A rejected bundle costs one request and one message: the caller learns which line of `SKILL.md` or which archive entry was the problem, and nothing was written.
- Two surfaces now answer skill writes with two error vocabularies. A business layer that speaks to both — the jeecg bridge does — needs a mapping for the seam codes the admin face emits directly, and its bundled-zip path is the same code either way.
- The listing surface reports unloadable entries rather than dropping them, so a management screen must render `loadable: false` with its issues instead of assuming every entry is usable.