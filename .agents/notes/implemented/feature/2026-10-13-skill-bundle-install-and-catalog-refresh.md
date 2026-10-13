# Agent Note: Skill bundle installation and an explicit catalog refresh

Status: implemented

## Problem

`ctx.skills` caches every completed catalog under `(cwd, scope chain, revision)`, and `revision` moves only for in-process reasons: a provider registers or disposes, an active registration calls its `invalidate` control, a project watcher is evicted, or a first-party `write`/`edit` observation dirties a root. The watchers added by [skill catalog hot refresh](2026-07-27-skill-catalog-hot-refresh.md) cover the roots they were given at discovery time.

Ambient tier roots are not those roots. An operator places a skill directory into the system tier on shared storage, from another host or another Pod, and nothing in the process learns about it: the watchers hold inodes of the directory entries scanned at startup, a new directory is not among them, and a new session reuses the same process-level cache. The name is then absent from `<available_skills>` until the host restarts. Operators worked around it with a rollout restart, which interrupts live sessions.

The same gap had a second face. A skill document is judged twice — once when the filesystem provider loads it and once when an importer accepts it — and the provider's judgement was a private parser that returned `undefined` and logged nothing actionable, so a document rejected at upload time and a document silently skipped at discovery could disagree, and neither told an operator which line was wrong.

## Decision

**One explicit refresh.** `ctx.skills.refresh(): { revision }` drops every completed catalog synchronously and returns the revision now in effect; the next read asks every provider again and observers are notified once per call. It is not a provider capability: providers keep their registration-scoped `invalidate` control for their own observation mechanism, while a caller that changed a backing store on nobody's behalf calls `refresh()`.

**One home for the document format.** `@deepseek-ai/dsh-skill` owns `readSkillDocument(raw)`, `isSkillName(name)`, and the tier vocabulary `SKILL_TIER_KINDS`. `readSkillDocument` returns either a document or a list of `{ code, message, line? }` issues with codes such as `frontmatter-unterminated`, `name-invalid`, and `description-missing`. `@deepseek-ai/dsh-skill-filesystem` deleted its private parser and calls the shared reader, so its skip warnings now name the code and line of the document it refused.

**`@deepseek-ai/dsh-skill-install` owns mutation.** The new `ctx.skillInstall` service installs, replaces, and removes one skill per call in a tier resolved through the ambient `ctx.skillTiers.roots()`, so it holds no path configuration and a platform caller reaches only the tiers its scope publishes. `install` extracts the zip with a streaming reader under a bundle-size cap, a 2048-entry cap, a running expanded-bytes cap, and a path guard that refuses absolute, drive-lettered, empty-segment, and escaping entries; requires exactly one root `SKILL.md`, stripping one wrapping directory when the archive holds one; validates the document; and only then writes into a staging directory inside the tier and swaps it in with a single `rename`, moving any replaced directory aside and back on failure. `remove` accepts the directory name or the frontmatter name and refuses an ambiguous match. `list` reports each tier entry with the coded reasons it never reaches the catalog, which is what an operator needs for a document placed by hand.

**The refresh is part of every mutation.** `install` and `remove` call `ctx.skills.refresh()` after the directory change and then re-read the tier's catalog, reporting the outcome as `visible`. A mutation path added later calls the same method rather than reaching into the registry cache or the watchers.

**The management surface serves it.** [`@deepseek-ai/dsh-tenant-admin-http`](../../../../packages/tenant/tenant-admin-http/README.md) adds `POST /admin/skills.list`, `/admin/skills.upload`, and `/admin/skills.remove` to the existing method table: same administrative scope, same error envelope, `zip` as base64 inside the JSON payload, and a separate `maxUploadBodyBytes` cap (32 MiB default) that only the `skills.*` methods are buffered under, because base64 inflates the archive by a third. Every refusal from the installer passes through unchanged as the error code with a status chosen per code (`400` for a malformed bundle or document, `404` for an absent skill, `409` for a name conflict, `413` for an oversized expansion, `503` for an unpublished tier), and a composition without the installer answers `503 skill-install-unavailable` instead of appearing to mount the methods.

**The tenant composition mounts the installer by default.** The `skill-install` spine row sits next to `skill-tier`, and `assertMountedServices` fails startup when that row is enabled but the service did not load.

## Alternatives considered

**Extend the registration-scoped invalidation of the 2026-07-27 decision to the installer.** The installer is not a provider, so it has no registration to invalidate, and the filesystem provider's first-party mutation hook only observes writes the agent's own tools made inside a session. An operator's upload arrives over HTTP with no filesystem observation at all, so a registry-wide entry point was needed. The registration control remains, unchanged, for providers that own their observation mechanism.

**Watch the tier roots instead of exposing a refresh method.** Chokidar would need one watch per tier directory per Pod on a shared filesystem, and its delivery for a write made from another Pod is exactly the guarantee that failed here; the operator's `scp`/`kubectl cp` into a tier directory is the case under repair. A synchronous call at the mutation site is bounded, testable, and costs nothing when unused. Watchers stay for the roots they already cover.

**Have the installer write files into the tier directory directly.** Without the staging step there is no rollback, without the guards a crafted entry escapes the skill directory, and without validation a document that cannot register lands on disk and then disappears silently — the failure mode this change exists to remove.

**Judge the document in each consumer.** Two parsers for one format are two answers, and they drift: the upload path would accept documents the runtime skips or the reverse. The shared reader in the Service Definition package makes the runtime skip and the refusal the same judgement, which is also why the tier vocabulary became a runtime value both sides import.

**A separate upload surface, or multipart.** The management carrier already owns the method table, the scope gate, and the single error envelope; a second surface would duplicate admission and split the wire reference. Base64 in the existing envelope is the smaller change, at the cost of buffering the whole request — recorded as a limitation rather than solved speculatively.

## Consequences

- Catalog staleness is now an explicit contract: whoever changes a backing store calls `refresh()`. The method is synchronous and drops every catalog, so a caller cannot leave one view stale while refreshing another.
- The document format has one owner. Skipped skills and refused uploads report the same codes and lines, and the format cannot drift between the loader and an importer.
- `skill-filesystem` lost its `yaml` dependency and its private parser; `dsh-skill` gained the dependency, because the format it defines is the one it now parses.
- Uploads are bounded but buffered: the request cap, the bundle cap, and the expanded cap are separate numbers, and the carrier's per-method cap is what keeps a memory bound on concurrent uploads.
- A replaced skill directory is briefly absent between the two renames. A concurrent reader can miss that one skill for that window; the tier directory itself is never partially written.
- `skills.*` methods exist only where the installer is mounted, and the composition asserts that at startup rather than answering a runtime 503 in a default deployment.

## Testing

`@deepseek-ai/dsh-skill-install` boots the real stack — registry, filesystem provider, ambient tier provider, installer — over a temporary system tier and covers the refresh effect, wrapper stripping, replacement, removal by either name, and every refusal (invalid document with its line, unsafe entry, oversized expansion, non-archive bytes, unpublished tier, absent skill). `@deepseek-ai/dsh-tenant-admin-http` drives the three methods over HTTP with a platform token and asserts the refreshed catalog, the pass-through codes, and the unmounted-service answer; its wire-reference test counts the published paths.
