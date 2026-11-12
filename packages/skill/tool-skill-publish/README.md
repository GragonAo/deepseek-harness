# @deepseek-ai/dsh-tool-skill-publish

English | [中文](README.zh.md)

The model-facing `skill_publish` tool: hand a skill the agent has written, as ordinary files, to the deployment's management plane, which records it and installs it.

Requires `ctx.fs`, `ctx.tools`, and an ambient user (`inject: ['fs', 'tools']`, subject read through `requireUser()`).

A skill is written where the model already writes files — the session workspace. Publishing therefore takes a directory, not content: the plugin walks that tree through `ctx.fs`, checks the document, and POSTs the files as one zip. Nothing the model wrote crosses back through the tool call, so publishing a 200 KB skill costs the tokens of one path instead of the base64 of an archive.

## Nothing is installed here

The management plane owns the record **and** the installation. Its skill list, the skills the host has on disk, and the catalog a later session reads have to say the same thing, so exactly one component writes them: the platform. A skill the platform does not know about is one the user cannot see, enable, disable, or delete — installing it locally first would create exactly the disagreement this plugin exists to avoid.

A publication therefore succeeds only when the platform accepted the archive, and a deployment with no configured target fails to load instead of accepting publications it could not file.

## Tool: `skill_publish`

| Arg | Type | Notes |
|---|---|---|
| `path` | string (required) | Directory holding `SKILL.md`, relative to the session cwd or absolute. |

The walk resolves `path` against the calling session's `session.header.cwd`, so a relative directory means the same thing the model's file tools meant. It skips packaging noise (`.git`, `node_modules`, `__MACOSX`, `.DS_Store`, `._*`), applies `maxFiles`, `maxFileBytes`, and `maxTotalBytes` while reading, and refuses a non-regular entry rather than silently dropping it. The document is checked with `readSkillDocument` before anything is sent, so a malformed `SKILL.md` is reported in the conversation instead of as a platform rejection.

A successful call returns `{ name, fileCount, replaced }`, plus `id` when the platform reported the record it filed. Publishing a name the library already holds replaces that earlier record — the platform deletes the duplicate row and installs the new archive over the old directory.

## Submission

| Config | Type | Notes |
|---|---|---|
| `record` | object (required) | The management plane that files and installs the skill. |
| `record.url` | string (required) | Ingestion endpoint that accepts `multipart/form-data`. |
| `record.token` | string (one of `token` / `tokenEnv`) | Token sent as `x-dsh-ingest-token`; the endpoint rejects a mismatch. |
| `record.tokenEnv` | string (one of `token` / `tokenEnv`) | Name of the environment variable holding that token, for deployments that deliver it as a Secret. Read once at load, so an unset or blank variable fails the load. |
| `record.timeoutMs` | number | Deadline in milliseconds. Defaults to `30000`: the platform stores the archive and installs it back through the host before it answers, and a cold host's first outbound connection has been measured past 10 s. |

A publication POSTs the archive it built — `subject` (the account owning the skill, read from the request's ambient user), `origin`, and the zip as `file`. The archive travels as bytes in the body; no base64 rendition of it enters the conversation, and the model's call still holds only a path.

The matching server side is `POST /dsh/inner/skill/ingest` in this deployment's platform, which stores the archive against the account, records it, and installs it into that account's skill directory; both sides read the same shared token from their own configuration. That platform answers every request with its own envelope (`{ success, code, message, result: { ok, id, name, userId, replacedRows } }`) and reports a refusal — including a rejected token — as HTTP 200 with `success: false`, so a 2xx alone is not evidence: the plugin reads the envelope and treats `success: false` or `result.ok: false` as a refusal, while a 2xx body that is not that envelope keeps the status as the verdict. A refusal carries the platform's own explanation — the body up to 300 characters, which for this endpoint is the operator's actual diagnostic ("令牌不匹配", "找不到发布者对应的账号") — so the gap can be diagnosed from the conversation instead of the platform log.

A half-configured `record` — a URL without a token, a token named twice, a `tokenEnv` the environment does not provide, or any blank value — fails at load instead of failing on every publication.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`skill_publish` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill-publish): `path` (required), with a description saying the directory must hold `SKILL.md`, that every other file in it is published too, that content is never pasted or archived into the call, and that publishing an existing name replaces it.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged.

### Tool-call history and result

#### What the model sees

Each call retains `path` in its arguments — one path, never the skill's contents. Success returns exactly one sentence: `Published the skill "<name>" (<n> files) to the skill library: the platform recorded it and installed it, so the catalog lists it now and a later request can trigger it.` A replacement inserts `, replacing an earlier skill of the same name` before the comma that opens the consequence. Stable failures name the cause and the next step: `There is nothing at <path>. …`, `<path> is not a directory. …`, `<entry> is not a regular file. …`, `That directory holds no SKILL.md at its root, and a skill has exactly one. Files found: …`, `SKILL.md cannot be loaded as a skill: <code> (line <n>): <message>. …`, `The skill holds more than <n> files. …`, `<file> is larger than <n> bytes. …`, `The skill is larger than <n> bytes. …`, `This session has no account, so nothing can be filed in a skill library. …`, `The skill library answered HTTP <status>: <body>. Nothing was published.`, `The skill library refused the publication: <platform message>. Nothing was published — fix that and publish again.`, and `The skill library could not be reached: <reason>. Nothing was published — this deployment installs skills only through its platform, so this call did not land.`

#### Token effect

One short result per call, independent of the skill's size: the files are read from the session workspace and never rendered into the conversation. A failed call adds only its error line.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No platform, no publication** — the plugin refuses to load without a target, so a deployment that cannot reach its management plane cannot publish at all. That is the intended trade: a skill the platform does not list is not a skill its user can use.
- **The install is the platform's, so its failures arrive as refusals** — a name the host rejects (non-kebab-case `name`, empty `description`) is caught locally first, but anything the platform's own installer refuses is reported as the platform's own words.
- **A rolled-back record can leave the archive in storage** — the platform's transaction covers the row and the installation, not the object it already wrote.
- **Symlinked entries are refused** — the walk publishes regular files only, so a skill that links shared material has to copy it in first.
- **No dry run** — the bounds and the document check run against the real directory; an oversized tree is rejected after its files were read.
