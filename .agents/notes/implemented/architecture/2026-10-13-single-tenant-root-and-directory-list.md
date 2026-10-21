# Agent Note: Single tenant root and directory list

Status: implemented

English | [中文](2026-10-13-single-tenant-root-and-directory-list.zh.md)

## Problem

A tenant's host directories were declared in three places that could disagree: each container provider built a mount table from its own config roots, `tenant-admin` created directories from its own list, and the deployment documentation told operators which subdirectories to create by hand. A path known to only one of them fails silently, because a container runtime that is handed a missing bind-mount source creates an empty directory instead of refusing: the deployment's system skill tier mounted as an empty layer and nothing reported it. Two trees also sat outside the deployment's data root (`/opt/dsh/tenants`, `/opt/dsh/tools`), so mounting one root was not true of the deployment.

## Decision

Host paths are declared once, in `@deepseek-ai/dsh-tenant`:

- `tenantDirectories(input)` returns every directory a tenant and its members need on the host — parents before children, duplicates collapsed. `tenant-admin` creates exactly that list, on tenant provisioning (`bootstrapTenantDirs`), on `users.ensure`, and on startup when the record store mounts (`hydrate`), so no operator creates a subdirectory by hand.
- `TENANT_TIER_DIRS` plus the `TENANT_SHARED_DIR_NAME` / `TENANT_USERS_DIR_NAME` / `TENANT_SKILL_DIR_NAME` constants carry the directory names both container providers spell their mount sources with, so renaming a tier cannot leave one side mounting the older path.
- `tenant-admin` holds `systemRoot` and `pythonRoot`, wired from the sandbox section during `tenant-app` composition, so the deployment-wide roots join the same list instead of depending on an operator or an image `RUN mkdir`.

The sandbox aggregate root `/opt/data/skills` is a container-local mount (`kind: 'local'`) in the k8s provider, inserted immediately before the first tier that hangs under it. A Pod volume mount point inside a read-only source (`/shared`, `/global`) cannot be created while the pod's mounts are set up, so the tier mount points need a writable parent the pod supplies itself; `docker -v` creates missing targets, so the docker provider needs no equivalent entry.

Every deployment root stays configuration: the code hardcodes no default for `dataRoot`, `workspaceRoot`, `usersRoot`, `archiveRoot`, `toolsRoot`, `systemRoot`, or `pythonRoot`.

## Alternatives considered

- **Let each provider keep its own mount table.** Rejected: the two tables are one list by intent, and every drift between them and `tenant-admin`'s list is the silent-empty-layer failure above.
- **Have the deployment create the directories.** Rejected: it turns each new tier into a manual step, and the deployments that failed here failed because nobody ran it — while the tenant plane already owns the tenant's directories.
- **Require operators to pre-create the shared roots.** Rejected for the same reason: the roots are configuration, so the plane that reads the configuration creates what it names.
- **Mount `/opt/data/skills` from the host.** Rejected: it adds a claim source and buys nothing, since the tiers are already projected individually.
- **Add a plugin `start()` lifecycle for startup creation.** Rejected: no `Service` subclass under `packages/*/src` uses one, and the record store's arrival is already the ordering contract hydration waits on.

## Consequences

- Creating a directory and mounting it now derive from one function: a path that enters a mount table must first enter the list, and `packages/tenant/tenant/tests/layout.spec.ts` pins the names.
- `tenant-admin` also creates `toolsRoot` and `archiveRoot`, which its previous list left out.
- Startup creation runs inside hydration, which the plugin does not expose as an awaitable readiness point, so a test cannot yet assert post-hydration state deterministically.
- The deployment still has to point `workspaceRoot` and `DSH_TENANT_WORKSPACE_ROOT` under the single `.dsh` root: those values are required configuration rather than defaults.

## Related

The host-side supply of the same three skill tiers is [2026-10-13](../../implemented/bug-fix/2026-10-13-tenant-app-skill-tier-wiring.md), which records the coupling this note removes: the container mount and the host scan now name `<systemRoot>/skills` through one shared directory name and one creation list, instead of two configurations that have to be kept in step.