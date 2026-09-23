# Agent Note: Case-platform coordinates live in configuration

Status: implemented

English | [中文](2026-09-23-case-platform-coordinates-in-configuration.zh.md)

## Problem

A case skill produces a report inside its sandbox and the case platform keeps the case's records; nothing carried the first to the second. The capability existed in the Hermes deployment as a plugin whose platform address was written into its source, and that address is the one value that differs between deployments: a DSH host reaches the platform at the port its compose publishes on the host, a Hermes sandbox reaches it by its compose service name, and neither address resolves from the other side. An address compiled into the plugin makes the artifact deployment-specific and fails at the first upload rather than at load.

The same platform is also reachable over MCP. The DSH deployment mounted one of its twelve serverKeys, so a skill written against the Hermes deployment found a fraction of the analysis tools it calls.

## Decision

The case platform's coordinates are configuration in the mountable patch layers. No package carries an address.

### The sync tools are a mounted plugin

A plugin directory the deployment mounts registers two model-facing tools over the jeecg-boot backend. It is named `local:report-sync` from the profile patch, and `@deepseek-ai/dsh-plugin-roots` resolves that reference into the mounted directory ([mounted plugin roots](2026-09-23-mounted-plugin-roots.md)). Adding or updating a tool is a file drop plus one config row, with no image rebuild, which is the whole reason it is not a published package:

- `sync_file_report` registers a report the sandbox already produced, posting `userId`, `caseId`, `fileName` and the optional `template` / `caseName` as a form to `POST <serverUrl>/jeecg-boot/report/upload`. It returns the platform's report id, which is the jeecg `Result` envelope's `result` string. The platform locates the file by case id and file name inside the case volume, so `file_name` is a name and not a path.
- `sync_file_skill` reads a 技战法 package through `ctx.fs` — so the path is whatever the calling sandbox sees — and posts it as a multipart form with `typeId` and `userId` to `POST <serverUrl>/jeecg-boot/jzf/user/import`.

`Config.serverUrl` is required and carries no default. `Config.accessTokenEnv` is a credential reference (`z.string().role('credential-ref')`, default `REPORT_ACCESS_TOKEN`) resolved per call through `ctx.credentials` and falling back to the launch environment, so a rotation reaches the next call and the token is never configuration. `Config.timeoutMs` (default 120000) bounds one round trip through `deadline()`; `Config.maxUploadBytes` (default 64 MiB) bounds the package read. An invalid `serverUrl` or credential reference fails at load, not at the first call.

Both tools take their identity from the authenticated request the call runs in: `case_id` is `requireTenant().id` and the platform's `userId` is `requireUser()`. Neither tool accepts a case id, a user id, or a server address as an argument. Every failure — an unreachable platform, a non-2xx response, an envelope reporting `success: false`, a success carrying no id — becomes one tool failure result whose message names the endpoint and the platform's own reason and never carries the token. A redirect is refused rather than followed, so a credential-bearing request is never replayed at a redirect target.

### The MCP server set is a row list in the mountable bundle patch

`packages/bundle/multi-tenant/cordis.patch.yml` inserts one `@deepseek-ai/dsh-mcp-client` instance per serverKey — `case`, `bill`, `callrecord`, `property`, `relationship`, `trajectory`, `timeline`, `persona`, `specialized`, `doubt`, `import`, `ai-analysis` — each with `serverName: icac-<serverKey>`, so a case session gets `mcp__icac-bill__*` and its siblings beside `mcp__icac-case__*`. The block states that its addresses are the deployment's rather than the product's, and names both forms an operator meets: `http://127.0.0.1:19830` for a DSH host that shares the host network, and `http://jeecg-boot-mcp-server:19830` for one on a container network.

## Alternatives considered

**Publish the sync tools as a repo package.** The Loader could already import an absolute path, so a package in `packages/` would work, and it would carry every repo gate the mounted directory does not — JSDoc, the invariant companion, typecheck, tests, dependency manifests. It loses on the operator's constraint: a package reaches a deployment only through an image, so every tool change would need a rebuild. The address still belongs in a `Config` field, and a mounted plugin declares one just as a package does.

**Give `serverUrl` a default.** A default address is an address that silently targets whatever the default names, and the failure it produces is a call that reaches the wrong backend or none. The port the platform is published on is a compose mapping, not a product fact. Requiring the field moves that failure to load, where it names the missing field.

**Keep `case_id` / `user_id` as tool parameters, as the Hermes plugin had.** The model would then choose which case's records a registration lands in, and the case platform's own authorization does not scope those endpoints per case. The authenticated request already knows both, so the parameters would only ever be a way to address another case. They are gone from the schema, and the executor reads the request authorities instead.

**Pass the access token as a literal `Config` value.** A token in a patch layer is a secret in the composition that reaches logs, diffs, and every reader of the file, and a rotation needs an edit and a reload. A credential reference keeps the token in the credential plane the deployment already mounts, and resolves it per call.

**Let the transport exception escape the tool.** An exception that carries a `fetch` failure or an abort reason is not something a model can act on, and a raw failure path is where a request body or header reaches the transcript. The client translates every failure into one message naming the endpoint and the platform's reason.

**Leave the MCP server set in the deployment's own profile patch.** That is where it was, and it works — for one deployment. The set is not secret and not host-specific beyond the address, so keeping it out of the repo means every deployment restates twelve rows to get the tools the case platform has. The rows now ship with the layer, and the deployment patch keeps only what is genuinely its own.

## Consequences

A deployment moves its case platform by editing `serverUrl` and the MCP row addresses in the patch layers; no image rebuild is involved. Adding or updating a sync tool is the same kind of edit — a directory in the configured plugin root plus its `local:` row — so the mounted-plugin capability is a one-time image requirement rather than a per-tool one.

A deployment whose profile patch already inserts any `mcp-icac-*` id must drop that row when this layer reaches it. A loader entry id may be inserted by one layer only, and a second insert is a duplicate-id failure at boot rather than an override — so the first boot after an image carrying these rows, with the old profile row still in place, fails before any tool is registered.

Both plugin endpoints are in the case platform's unauthenticated URL list, so an unset `REPORT_ACCESS_TOKEN` is the normal state and no `Authorization` header is sent. A deployment that fronts the platform with an authenticating gateway sets the reference instead.

The MCP client does not send the `_meta` the platform's MCP server reads `case_id` / `user_id` / `session` from, so every case falls back to the server-side default. That is a property of the client, not of this row list, and it is unchanged here.

The report is registered, not uploaded. The platform's `/report/upload` accepts an optional `file` part and this plugin does not send one, so a report the platform cannot see in the case volume fails on the platform side with the platform's own message.

The analysis type ids the tool description lists are the platform's seeded rows. They are documented for the model and not validated against the platform, so a deployment that reseeds its type table must restate them; only the numeric form is checked.
