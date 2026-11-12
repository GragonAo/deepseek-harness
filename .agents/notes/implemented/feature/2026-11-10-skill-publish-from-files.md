# Agent Note: A written skill publishes from its directory, not from an archive

Status: implemented

English | [中文](2026-11-10-skill-publish-from-files.zh.md)

The installation half of this decision was revisited in
[The management plane installs published skills, the host only submits them](2026-11-10-platform-owns-skill-install.md):
the tool described here reads, validates, and **submits** a directory, and the
platform installs it. This note keeps the transport decision and the reasons for
it.

## Problem

An agent that writes a skill had exactly one way to install it: `upload_skill`
on the platform MCP server, whose argument is a base64 zip. Everything about that
call fights the model that has to make it. The skill's bytes already exist on
disk, so the model re-derives them: it writes the files, zips them, base64s the
zip, and emits the result as a tool argument — 1.34× the archive in tokens, on
every retry, in one message that a long skill can push past the context limit
where it truncates and the call fails. A truncated base64 argument is not a
recoverable error the model can repair; it is a dead end.

The transport forced that shape rather than a design preference: the MCP server
runs in its own pod with no workspace volume, so it cannot read the tenant's
files, and base64 was the only way to get bytes into it. The harness — where the
files are — had no model-facing entry at all.

Two smaller consequences of the same gap: nothing told the model how to write a
skill people would actually want, so long generations landed as unreviewed walls
of text with no checkpoints for the user; and the publication left no artifact the
user could look at afterwards.

## Decision

`skill_publish(path)` in the package `@deepseek-ai/dsh-tool-skill-publish`. The
argument is a **directory**, not content. The plugin resolves it against the
calling session's `session.header.cwd`, walks it through `ctx.fs`, checks the
skill document with `readSkillDocument`, and zips the files it read straight into
the submission body — the bytes never become a tool argument and never pass back
through the model.

The submission is the whole of what the tool does. `record` names the
management plane's ingestion endpoint, and it is **required**: a deployment that
cannot say where to file a publication refuses to load, because publishing
something nothing can find again is worse than not offering the tool. The archive
travels as `multipart/form-data` (`subject` from the request's ambient account,
`origin`, and the zip as `file`) to the platform's
`POST /dsh/inner/skill/ingest`, which stores it, records it, and installs it — see
[the installation note](2026-11-10-platform-owns-skill-install.md) for why the
host must not do that itself.

Bounds are validated `Config` (`maxFiles`, `maxFileBytes`, `maxTotalBytes`)
rather than constants, so a deployment can raise them; the defaults only catch an
accidental tree. The document check runs before the upload, so a malformed
`SKILL.md` is a conversational error the model can fix rather than a platform
refusal after an archive went over the wire.

Refusals are translated into what the model should do next — no such directory, a
file instead of a directory, no `SKILL.md` at the root (with the files found), an
unloadable `SKILL.md`, an exceeded bound, a session with no account to file
under. A failed submission says outright that nothing was published, and carries
the platform's own explanation: this deployment's platform answers every request
with its own `{ success, code, message, result }` envelope and reports a refusal —
including a rejected token — as HTTP 200, so a 2xx alone is not evidence. The
plugin reads the envelope and treats `success: false` or `result.ok: false` as a
refusal; a real cluster run filed nothing while answering 200 before this. The
shared token is read from `record.token` or, for deployments that hand it over as
a Secret, from the environment variable `record.tokenEnv` names — resolved once at
load, so a missing variable stops the host instead of failing every publication.
This stack takes the second path: the tenant configuration is a mounted object, so
it names `DSH_SKILL_INGEST_TOKEN` and the value arrives from the same Secret the
platform reads. The deadline is 30s rather than a round-trip figure because the hop
is not a round trip: the platform stores the archive and installs it back through
the host before it answers, and the first publication after a host restart was
refused against a 10s deadline while the platform had no record of the request at
all — a false "not recorded" the model would have relayed to the user as a real gap.

Guidance ships as a **system skill** (`deploy-kit/system-skills/skill-authoring`)
rather than a prompt change: it is the co-creation procedure (clarify, agree on a
skeleton, write one section at a time with checkpoints, test-run, publish), it
belongs to the skill family it describes, and it installs through the existing
「系统技战法管理」 enable flow without an image rebuild.

## Alternatives considered

**Keep `upload_skill` and shrink the payload.** Compressing harder or chunking the
archive keeps the model in the byte path, which is the defect: the model must
still emit the bytes, and any chunking protocol costs several calls and a
reassembly protocol in the tool. Reading the directory removes the transfer
instead of optimizing it.

**Mount the workspace into the MCP server pod.** It would let the executor read
files, but it would also give a Spring process write access to every tenant's
tree — the reason the base64 hop exists is that the MCP server is outside the
tier directories' trust plane. The host already holds the files; reading them
there is the part that belongs in the harness.

**Have the tool take the zip as a session file path.** A model that has already
written a zip would still have had to build it, and the archive format buys
nothing once the files are readable in place. Requiring a zip also invites the
"zip the parent directory" mistake, whose wrapper-directory tolerance then
depends on how the zip was made.

**Skip the platform and install straight into the tier.** This is what the first
implementation did, and it produced the disagreement
[the installation note](2026-11-10-platform-owns-skill-install.md) is about: a
skill the model can use and the user cannot see, or manage.

## Consequences

The model's cost of publishing is now one path plus the resulting sentence,
independent of the skill's size, and the failure modes are conversational
(missing directory, bad document, exceeded bound) or the platform's own refusal —
never a truncated transport.

`tool-skill-publish` is composed in the tenant spine next to `tool-skill`, so
every tenant session gets it. It depends on `ctx.fs`, `ctx.tools`, and an ambient
account, and on no installation seam at all: `@deepseek-ai/dsh-skill-install`
is back to its single archive entry point, so there is no second implementation
of "files become a skill directory" to keep in step.

The platform MCP tool `upload_skill` is **deleted**, not disabled: the executor, the
Feign client behind it and the base64 ingestion endpoint it posted to are gone from
the codebase, and `V3.9.2.28__drop_upload_skill.sql` removes the tool row that would
otherwise point at a missing executor. A row whose executor no longer exists is worse
than no row — it surfaces in the tool list and fails at call time with a lookup error
model and operator cannot act on. The `mcp_server_platform` group itself stays as the
mounting point for future platform-level tools.

The user-visible record of a publication is the platform's: its `jzf_user` row, the
archive it stores, and the directory its installer writes. What the user sees on the
page and what the model can trigger are the same record.

## Testing

`packages/skill/tool-skill-publish/tests/publish.spec.ts` drives the registered tool
through `ctx.tools.execute` against a stand-in ingestion endpoint: the archive's
paths, the shared token, the account from `runWithUser`, the walk's refusals, the
document check, both bounds, the account check, and every platform outcome
(refusal envelope, refusal in `result`, non-2xx, a body that is not the envelope, a
truncated body, an unreachable host, an expired deadline), plus the load-time
refusals of a missing or half-configured target. The installation note describes
the same suite in the terms of who installs.

`packages/skill/skill-install/tests/skill-install.spec.ts` keeps covering the archive
path only: a plain installation and its catalog refresh, wrapper stripping and path
normalization, a directory entry and a repeated path, an escaping path, both bounds,
an unloadable document, an unpublished tier, the replace/refuse pair, and an aborted
call that leaves the tier untouched.
