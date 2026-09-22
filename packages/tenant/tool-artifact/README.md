# @deepseek-ai/dsh-tool-artifact

English | 中文

Case-scoped artifact delivery. A model working in a container sandbox writes reports, HTML summaries, charts, and data exports where only the sandbox can see them, so the user — who reaches the deployment through a web front end — never receives them. This plugin closes that gap with two model-facing tools: `artifact_publish` copies a generated file into the case's static directory (the one the front end serves) and returns the same-origin path plus the delivery tag the model appends to its reply; `artifact_list` reports what this subject already delivered.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-tool-artifact'
  config:
    mediaRoot: /srv/cases-static          # host directory the front end serves
    urlPrefix: /media                     # same-origin route the front end serves it under
    publicOrigin: https://cases.example.cn         # optional; front-end origin, for the absolute `url` only
    usersRoot: /var/lib/dsh/users         # host root mounted at /global; omit when absent
    groupByKind: true                     # file into <kind>/ subdirectories
    maxBytes: 104857600                   # largest publishable file
```

`mediaRoot` must be the directory the deployment's web front end actually serves, and `urlPrefix` the route it serves it under. A mismatch publishes successfully and yields dead links, so verify with one real publish and one fetch of the returned path. `publicOrigin` is an origin alone — the absolute `url` is `publicOrigin` + `public_path`, so including the route in it would double the prefix.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `artifact_publish` | `file_path` (required, absolute or working-directory-relative), `title`, `kind`, `move` | `name`, `kind`, `public_path`, `url` (when `publicOrigin` is set), `attachment_tag`, `bytes`, `source_path`, `moved` |
| `artifact_list` | `limit` (default 50, max 200) | `entries` (`name`, `kind`, `public_path`, `bytes`, `modified`, newest first), `total` |

```
<mediaRoot>/<case>/<subject>/<kind>/<YYYYmmdd_HHMMSS>_<title>.<ext>
```

`kind` is inferred from the extension — `html`, `docs`, `sheets`, `slides`, `images`, `data`, `packages`, `other` — and `groupByKind: false` drops that directory. Publishing copies by default, so the source stays readable in the sandbox; `move: true` removes it after a successful copy.

## Where the model's paths resolve

The plugin reads through the same mounts the container provider binds for the calling subject, so a path the sandbox can write is exactly a path this tool can read:

| The model writes | Host path this plugin reads | Delivered under |
|---|---|---|
| `/workspace/<rel>` | `<tenant.workspaceRoot>/users/<subject>/<rel>` | `<mediaRoot>/<case>/<subject>/…` |
| `/shared/<rel>` | `<tenant.workspaceRoot>/shared/<rel>` | `<mediaRoot>/<case>/<subject>/…` |
| `/global/<rel>` | `<usersRoot>/<subject>/<rel>` | `<mediaRoot>/<case>/<subject>/…` |

A path outside those mounts is rejected, and the resolved file is re-checked after symlinks are followed, so a link planted inside a mount cannot read outside it.

## Isolation

Publication is scoped twice, by the request authorities the deployment authenticates: the **case** (`requireTenant()`) and the **subject** (`requireUser()`). A call reads only from the calling subject's mounts, writes only below `<mediaRoot>/<case>/<subject>`, and lists only that directory. A subject cannot address another subject's workspace, publish another subject's file, or enumerate another subject's deliveries; another case is a different tenant and therefore a different directory. A call outside a case-scoped request fails loud rather than falling back to a shared directory.

## Model Experience

### Delivering a generated file

#### What the model sees

`artifact_publish` returns the delivered file's same-origin path and the delivery tag, with one instruction: append the tag to the reply verbatim as its own paragraph. When the copy left the source in place, the result also names the source path, so the model can read the file again in a later turn. `artifact_list` returns this subject's deliveries, newest first.

#### Token effect

Two tool schemas stay resident (~250 tokens together). Each call adds one short result: a published file's path, tag, and size, or one line per listed delivery.

#### KV Cache effect

Append-only; results follow the reusable request prefix.

## Known Limitations and Deferred Work

- **The static route itself carries no per-subject authorization.** `urlPrefix` is served by the front end's static handler, so any client that knows a published path can fetch it. Isolation here governs what the model can address and enumerate; a deployment that needs URL-level enforcement must add it at the front end or place an unguessable segment under `mediaRoot`.
- **Delivery is copy-then-record, with no index.** `artifact_list` reads the directory, so a title or provenance per delivery is not retained beyond the file name.
- **Case and subject identity in the path comes from the tenant id and user id, sanitized.** A deployment whose ids differ only in characters sanitization strips would collide in the same directory.
- **One physical directory per case.** A multi-replica deployment must share `mediaRoot` (a shared volume or network filesystem); nothing here coordinates two replicas writing the same timestamped name beyond exclusive file creation.
