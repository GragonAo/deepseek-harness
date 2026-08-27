# Agent Note: Multi-tenant skill tier supply

Status: implemented

English | [中文](2026-08-26-multi-tenant-skill-tier-supply.zh.md)

## Problem

The multi-tenant carrier ([2026-08-24](2026-08-24-multi-tenant-slice.md)) isolates each (tenant, user) scope's files, memory, and container, but skills still resolve through the single-user `dsh-skill-filesystem` provider, whose roots — project, custom, user DSH, user agents, bundled — key to one harness home with no notion of a tenant or subject. The three-tier supply requirement needs the same skill name to resolve nearest-tier-wins (case-shared `/shared` outranks user-global `/global`, which outranks the system tier) with distinct names unioning, and needs the case and user-global directories resolved from the request's own (tenant, user) authority rather than any host-global path.

## Decision

Add an ambient tier service the filesystem provider reads on every discovery, and resolve its three roots from the authority scopes on each call.

- **`@deepseek-ai/dsh-skill`** gains `CASE_SKILL_RANK` `30`, `USER_GLOBAL_SKILL_RANK` `40`, and `SYSTEM_SKILL_RANK` `50` (below every static provider rank, `100`+), the `SkillTierKind`/`SkillTierRoot`/`SkillTierProvider` types, and an optional `ctx.skillTiers` Context augmentation.
- **`@deepseek-ai/dsh-skill-filesystem`** appends `this.ctx.get('skillTiers')?.roots() ?? []` before its static roots. The optional service must be read through `ctx.get` (strict store read of the optional-service idiom), not the topology-sensitive property proxy, and is skipped when absent.
- **`@deepseek-ai/dsh-skill-tier`** (new package) registers `ctx.skillTiers` as a state-free `Service`: `roots()` reads `currentTenant()`/`currentUser()` and returns the case root `<tenant.workspaceRoot>/shared/skills`, the user-global root `<usersRoot>/<sub>/skills`, and the system root (`systemSkillsDir`, default `$DSH_HOME/system/skills`), all `trustedHost: true` because they are host paths outside the tenant container.
- **Bundle** — `multi-tenant/cordis.patch.yml` mounts `skill-tier` (`dsh-skill-tier`) with `usersRoot` from `DSH_USERS_ROOT`, beside `container-runtime` which consumes the same value.

The ambient read is correct without cache-key changes: the skill registry's collect cache is keyed by `{ cwd, scopeChain, revision }`, and every multi-tenant lookup passes a session-unique scope key, so per-request tier roots land in a per-session cache entry.

## Alternatives considered

- **Wire the three directories as static `customSkillDirs` in the bundle** — fixed boot-time paths cannot vary per (tenant, user), so one tenant's case skills would leak into every other request. Chosen: ambient service.
- **Extend `skill-filesystem` config with `usersRoot`** — folds tenant authority into the single-user provider and still leaves the system tier and the case-shared path uncaptured. Chosen: a separate carrier package.
- **Resolve tier roots at boot** — a boot-time snapshot misses a scope or a directory created after start; the state-free read per `roots()` call is what makes the tiers follow the request.

## Consequences

**Bought:** case > user-global > system precedence (lower rank wins within the filesystem provider's single layer) plus union of distinct names; the tier directories resolve from the request's own authority; all three roots bypass the container-scoped file service via `trustedHost`. Single-user installs never register `ctx.skillTiers` and are unchanged.

**Cost and deferred work:** this is the skill tier only; the 4-tier configuration supply is the remaining slice still to ship (the 3-tier tool supply shipped in [2026-08-26](2026-08-26-multi-tenant-tool-manifest-loader.md)). The system tier is read-only by convention, not enforcement — deployment owns creating the directory and keeping it const. The deployed `192.168.138.130` closed-loop turn over the real Loader + Docker + Postgres remains the server step.

### Verification

`tsc -b` on the skill, skill-filesystem, skill-tier, and bundle packages passes. Four `skill-tier` unit tests cover root resolution, in-scope vs. out-of-scope tiers, and the `$DSH_HOME` default for the system root. One `skill-filesystem` integration test boots the registry + a fixed tier service and asserts `case > user-global > system` for a same-named skill and union for the distinct names. `bundle/multi-tenant` tests assert the `skill-tier` mount and its `DSH_USERS_ROOT` pin. `verify-cordis-config`, `verify-export-jsdoc`, `verify-package-invariants`, `verify-translation-pairing`, and the README Model-Experience/limitations gates all pass.