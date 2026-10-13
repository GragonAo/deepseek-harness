# Agent Note: Sandbox skill tiers arrive as mounts, not as a symlink

Status: implemented

English | [中文](2026-10-08-sandbox-skill-tiers-are-mounts.zh.md)

## Problem

Case skills are addressed as `/opt/data/skills/<skill>/...`: the case's own scripts were written against the host layout that predates the sandbox, and the report builder they invoke is named by that absolute path. The tool-exec image answered that spelling with `ln -s /shared/skills /opt/data/skills`. The alias hardcodes a mount position anyway — the interpreter wrapper beside it exists for a different reason — so it removed no coupling; and since it can point at exactly one source, that path could never show more than the case tier, while the host-side registry merges three tiers (case, user-global, system) through `skill-tier`'s ranked roots.

## Decision

Skills reach the sandbox only as mounts. Every tier is mounted read-only under one root, `/opt/data/skills/<kind>`, with the kinds `skill-tier` already registers: `case` from `<workspaceRoot>/shared/skills`, `user-global` from `<usersRoot>/<subject>/skills`, and `system` from `<systemRoot>/skills`. Sandbox-side discovery is enumeration of that root, and a tier directory appears only when its configuring root does, which enumeration tolerates by construction. The image creates the directory (`mkdir -p /opt/data/skills`) and does nothing else: no in-container path any more names a mounted one, so no such path can dangle or go stale. Mounting one tree at both its host path and the aggregate costs no extra volume, because `volumesFor` keys volumes by backing store.

## Alternatives considered

- **Keep the symlink and point it at a host-assembled merged directory.** Rejected: the host would write and keep in sync a second view of data it already serves, and every tier added later has to be added in two places.
- **Mount the tiers flat into the root, keeping `/opt/data/skills/<skill>`.** Rejected: a mount carries one source to one path, so several tiers at one path is impossible, and two tiers carrying the same skill name would collide silently.
- **Move the case assets to the host-absolute spelling, `<workspaceRoot>/shared/skills/...`.** Rejected: those assets live outside the harness and are already deployed per case, while the aggregate root gives them one stable spelling that survives a backend switch.
- **Hard-link or copy the tiers into one directory at provisioning time.** Rejected: that is state to rebuild whenever a skill changes, and hard links do not cross the host-path/claim boundary this provider mounts across.

## Consequences

- A skill's sandbox path is now `/opt/data/skills/<kind>/<skill>/...`, not `/opt/data/skills/<skill>/...`. Callers that enumerate are unaffected; a caller that hardcodes the flat form must follow the tier.
- Three tier directories must exist before a sandbox starts: `<workspaceRoot>/shared/skills` (created by `dsh-tenant-admin` when a tenant is created), `<usersRoot>/<subject>/skills`, and `<systemRoot>/skills` (both from the deployment's own roots). `container-docker` fails the start with the path in its message; a claim deployment creates a missing `subPath` as an empty directory, so it fails later instead.
- Each tier of the aggregate is read-only. A sandbox cannot write a skill; the shared tier stays writable at `/shared`.
- The host-side tier merge is unchanged: `skill-tier` still reads its three host roots and ranks them ([supply note](2026-08-26-multi-tenant-skill-tier-supply.md)), and the sandbox aggregate is not that merge.
- `/opt/hermes/.venv/bin/python3` stays a wrapper script. Its reason is the missing interpreter, not an alias: it defers to `python3` from `PATH` and fails as `python3: not found` with nothing mounted, rather than running some other interpreter.

### Verification

- `packages/tenant/container-k8s/tests/pod-spec.spec.ts` asserts the three aggregate mounts, their read-only mode, that the tiers carrying host paths still round-trip, and that one tree mounted twice still occupies one volume.
- `packages/tenant/container-docker/tests/docker.spec.ts` asserts the three `-v` entries of the same table, so the two backends cannot drift apart.
- `pnpm exec tsc -b tsconfig.host.json` is clean, and both provider suites pass (83 of 86; the three failures are pre-existing Windows cases that need `sh`).
- On the cluster, a probe Pod of the rebuilt image reported `/opt/data/skills` as a directory, the interpreter wrapper as a regular file, `NO-PYTHON`, and an empty `find /opt /shared -type l`: the image names no mounted path at all.
- A real session on the deployed stack (`trial-tenant`/`trial-user`, claim mode) started a sandbox Pod whose `volumeMounts` carry `/opt/data/skills/{case,user-global,system}` beside the tiers' existing host paths, with the init container mounting the same table. That sandbox — read both by a direct `exec` and by the model's own `bash` tool call in a turn that ended `completed` — lists `/opt/data/skills` as a directory holding the three mounted tiers, with `find /opt/data -maxdepth 3 -type l` empty.
