# Agent Note: The sandbox mounts the system skill tree read-only

Status: implemented

English | [中文](2026-09-22-sandbox-system-skill-mount.zh.md)

## Problem

Skills have three tiers: case-shared (`<workspaceRoot>/shared/skills`) > user-global (`<usersRoot>/<sub>/skills`) > system (`$DSH_HOME/system/skills`). The sandbox container mounted only three directories:

```
<workspaceRoot>/users/<sub>  ->  /workspace
<workspaceRoot>/shared       ->  /shared
<usersRoot>/<sub>            ->  /global
```

The first two tiers' directories happen to fall inside those mount points, so their companion files are readable in the sandbox. The system tier is inside no mount point: a skill body reaches the model context through the host-side provider (large bodies also spill to the sandbox's `/tmp/dsh-spill-*`), while the companion files the body references — report templates, methodology, validation scripts, sample HTML — are unreadable in the sandbox.

A heavy-asset skill references those files by a path relative to the skill directory and requires running the scripts among them. Measured on a 55 KB clue-screening skill: after the agent loaded the body it followed the instruction to find `report_template.md`, could only search the whole filesystem with `find / -name`, did not find it, and the closing stage's `verify_delivery.py` could not run either.

## Decision

`container-docker` gains a `systemRoot` Config field that mounts the system skill tree read-only into the sandbox at the same absolute path:

```
-v <systemRoot>:<systemRoot>:ro
```

The same path rather than a fixed in-container location, because the relative paths a skill body references must resolve against the directory the host resolved; mounting elsewhere would break every one of those references. Read-only, because the sandbox only executes and does not own system assets. Omitting the field leaves behavior unchanged: the system skill tree stays host-side and only a body reaches the model.

The case and user tiers need no matching field: `/shared` and `/global` are already their mount points.

## Alternatives considered

- **A fixed in-container location** (e.g. `/system/skills`): rejected. Every companion-file reference in a skill body is relative to the skill directory, so the mount point must be the host path the provider resolved.
- **Mount the tree read-write**: rejected. The sandbox executes system assets and does not own them, so a writable shared tree would let one subject's writes change what every other subject reads.
- **Mount unconditionally instead of through a Config field**: rejected. The host path is deployment-varying, so a hardcoded path names a directory a deployment that installs elsewhere does not have, which the host-side check refuses.

## Consequences

- The deployment must ensure the host container mounts `$DSH_HOME` at the same absolute path as inside it: the host process reads the tree itself, and a path that is not there fails the sandbox start with that path named ([bind-mount source preflight](../bug-fix/2026-09-23-sandbox-mount-source-preflight.md)) instead of mounting an empty directory. `docker-compose.yml` and `.env.example` pin absolute paths for that constraint.
- The sandbox gains one read-only mount point, so everything under `/opt/.dsh/system` becomes visible to processes inside it (it holds no credentials; system skills are shared assets).
