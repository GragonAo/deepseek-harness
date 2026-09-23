# Agent Note: Sandbox bind-mount sources are provisioned and checked before the container starts

Status: implemented

English | [中文](2026-09-23-sandbox-mount-source-preflight.zh.md)

## Problem

A tenant created through the administrative API started its sandboxes with an empty `/workspace`. `container-docker` renders six `docker run -v <source>:<target>` arguments, and two of the sources had no creator anywhere in the tree: `<workspaceRoot>/users/<subject>` (mounted at `/workspace`) and `<workspaceRoot>/shared/skills` (mounted read-only at its own host path). `bootstrapTenantDirs` created `dataRoot` and `<workspaceRoot>/shared` only, and `bootstrapUserDirs` created only the `usersRoot` tier. The provider passed each source to the container CLI unexamined, and Docker creates a missing bind-mount source as an empty directory, so nothing failed at any point.

Measured on the deployment host: a tenant created through the API at 03:04 had `<workspaceRoot>/users/<sub>` and `<workspaceRoot>/shared/skills` with an mtime of 03:05 — the first tool call, not the create — while the directories `tenant-admin` did create carried 03:04. The session reported success throughout (`turn/end=completed`, 192 tools registered) and only `/workspace` was empty.

Two rules cover this state, and the defect satisfied neither: a missing referent is never silently skipped, and a misconfiguration fails loud at the earliest point that can resolve it. The referent here had no creator and no failing point.

## Decision

Each side of the missing creator owns one half of the fix.

`dsh-tenant-admin` provisions every per-tenant bind-mount source. `bootstrapTenantDirs(record)` creates the case-shared tiers `<workspaceRoot>/shared/{config,skills,tools}` from the same `TIER_DIRS` list the user tier uses, and each admitted member's `<workspaceRoot>/users/<subject>`. `bootstrapUserDirs(subject, workspaceRoot?)` gained the tenant's workspace root as an optional second parameter, because the `/global` tier and the case workspace have different owners: `create` and `membersAdd` pass the record's `workspaceRoot`, and `usersEnsure` passes nothing — that operation names only a subject, so it has no tenant whose workspace root it could create under. `membersAdd` resolves the record before it creates anything, so an unknown tenant no longer leaves a subject's host directories behind for a membership that failed.

`dsh-container-docker` checks every source on the host before it touches the container CLI. `startContainer` builds one `mounts(tenant, user)` list and renders both the check and the `-v` arguments from it, so a source cannot be mounted without being checked. `requireMountSources` probes each source with the injected `HostPathProbe` — the host-reads seam `src/python-env.ts` already defines for `pythonRoot` — and throws before the same-name container is cleared, naming every missing source, the container path it was for, and the (tenant, member) pair it belongs to:

```text
container-docker: refusing to start the sandbox of tenant 'api-demo' member 'api-user': bind-mount source '/opt/dsh/tenants/api-demo/workspace/users/api-user' (for '/workspace') is missing on this host. Docker creates a missing bind-mount source as an empty directory, so the start would report success and hand that subject an empty mount. Create each path on the host, or drop the configuration that names it: tenant-admin creates '<workspaceRoot>/shared/<tier>' and '<workspaceRoot>/users/<subject>' on tenant create and member add, and the deployment owns 'usersRoot', 'systemRoot', 'pythonRoot', and a tenant's 'toolsRoot'.
```

The check covers all six sources, not only the two that lacked a creator: `usersRoot`, `systemRoot`, and a tenant's `toolsRoot` reach `docker run` the same way, and a deployment whose `systemRoot` moved would otherwise mount an empty directory at the path every system-skill companion file is cited by. It runs on each cold start rather than once at load, so a source removed while the host is up fails the next start of that subject — the earliest point at which it can be noticed.

## Alternatives considered

- **Create a missing source inside `container-docker`.** Rejected. The provider cannot tell "nobody provisioned this tenant yet" from "an operator deleted this tenant's data", and it would write into directories it does not own — a tenant's `workspaceRoot` belongs to `dsh-tenant-admin`, and `systemRoot`/`pythonRoot` belong to the deployment. It would also make the failure unreachable: once the directory always exists, no state distinguishes a provisioned sandbox from one whose mount was never provisioned. Creation belongs to the owner of the directory; the provider's job is to refuse a start it cannot honor.
- **Document the required `mkdir` in the deployment README.** Rejected. The defect is exactly that the referent has no creator and no failing point, so a documented step leaves the deployment behaving as before until an operator notices an empty directory — the outcome the repository rule exists to prevent.
- **Have `usersEnsure` create the case workspace of every tenant admitting the subject.** Rejected. `tenant.admin.users.ensure` names only a subject, and its effect is the `usersRoot/<sub>/{config,skills,tools}` tree; deriving a tenant set from the registry would make one operation's effect depend on membership state the caller never named. Re-adding the member already repairs a case workspace, because `membersAdd` bootstraps on every call.
- **Fail at load instead of at start.** Rejected for the per-tenant sources: they are functions of the tenant record and the subject, neither of which exists at load, so load cannot name what is missing or for whom. `pythonRoot` keeps its own load-time check, which it can make because it is self-contained configuration.
- **Check only the two sources that lacked a creator.** Rejected. The silent empty mount is a property of the bind mount, not of those two paths; one uniform check over the mount list is what keeps a later mount from reintroducing the defect.

## Consequences

- A deployment whose `usersRoot`, `systemRoot`, `pythonRoot`, or tenant `toolsRoot` does not exist now fails its sandbox start instead of mounting an empty directory there. On a host where those paths exist, nothing changes.
- Directories Docker created before this change stay empty, and no migration distinguishes them from a legitimately empty workspace. A subject whose case workspace was created that way keeps the empty directory it already had; re-adding the member recreates a missing one, and content the subject wrote since is untouched.
- The injected `HostPathProbe` now serves two consumers — `pythonRoot` layout resolution at construction and mount-source checks at start — so a test that fakes the container runner must also state which host directories exist.
- Every cold start costs one `stat` per configured mount, and no container CLI call happens for a start that fails the check.

## Testing

- `packages/tenant/container-docker/tests/docker.spec.ts` covers a start whose case-workspace source is absent, asserting the message carries the path, its container target, and the (tenant, member) pair, and that no container CLI call was made; a host with none of the six sources, asserting one failure names all of them; and the existing start assertions, whose probe now reports the mount sources present. 29 tests pass in that file.
- `packages/tenant/tenant-admin/tests/tenant-admin.spec.ts` covers create provisioning `shared/{config,skills,tools}` and the member's case workspace, and `membersAdd` provisioning the case workspace of the subject it admits. 11 tests pass in that file.
- `packages/tenant/tenant-demo/tests/agent-isolation.spec.ts` and `http-parity.spec.ts` state the host's directories explicitly, since they fake the container runner.

## Verification

On the deployment host (multi-tenant profile: `usersRoot: /opt/dsh/.dsh/users`, `systemRoot: /opt/dsh/.dsh/system`, `pythonRoot: /opt/dsh/.dsh/pyenv`), against the built output of this change copied over the image's two `lib/index.js` files and hash-verified inside the container:

- A member's case workspace was moved aside, then the subject's session ran `ls -la /workspace` through the `bash` tool. The tool result was the refusal verbatim — `container-docker: refusing to start the sandbox of tenant 'api-demo' member 'api-user': bind-mount source '/opt/dsh/tenants/api-demo/workspace/users/api-user' (for '/workspace') is missing on this host.` — no sandbox container was created, and the host directory stayed absent: nothing silently created it.
- `tenant.admin.members.add` for that subject recreated the directory with the call's own mtime, and the next `ls -la /workspace` returned the directory's real contents through a running sandbox.
- A tenant created through `tenant.admin.create` had `workspace/users/<sub>`, `workspace/shared`, `workspace/shared/{config,skills,tools}`, and `usersRoot/<sub>` all carrying the create's mtime rather than the first tool call's. Inside that sandbox, `mount` listed all six bind mounts, the system skill tree held 3 entries, the Python environment held `bin/include/lib/share` with `python3 -V` reporting `Python 3.11.16` and `sys.prefix` under the mount, and a file written to `/workspace` appeared on the host in the program-created directory.
