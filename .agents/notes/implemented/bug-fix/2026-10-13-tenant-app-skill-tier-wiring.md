# Agent Note: Tenant app wires the three skill tiers

Status: implemented

English | [中文](2026-10-13-tenant-app-skill-tier-wiring.zh.md)

## Problem

A tenant session on the deployed host could not see any skill from the system tier — including the report-template skill the case run exists to drive. The tier carrier ([2026-08-26](2026-08-26-multi-tenant-skill-tier-supply.md)) publishes the three tier roots through `ctx.skillTiers`, and `@deepseek-ai/dsh-skill-filesystem` is the only reader that scans them; the tenant app composes its own spine rather than loading the `multi-tenant` profile, so the row that registers that reader was the one place the wiring could be missing.

It was missing in three ways at once. The `skill-filesystem` row carried `disabled:`, so the only scanner of the tier roots never registered and every tier skill was invisible. The `skill-tier` row supplied no `usersRoot`, which drops the whole user-global tier. And it supplied no `systemSkillsDir`, so that root fell back to `$DSH_HOME/system/skills` — `~/.dsh/system/skills` on the tenant host, where no such tree exists — while the deployment's system tier actually lives at `<sandbox.systemRoot>/skills`.

The failure is silent by construction: a missing root is an absent directory, not an error, so the registry simply reports a smaller catalog and the session proceeds without the skill it was meant to use.

## Decision

The tenant app's spine registers the filesystem reader and hands it exactly the three tier roots, with the two host paths the deployment actually uses.

- **`skill-filesystem`** drops `disabled:` and carries `config: () => ({ includeDefaultRoots: false })`. The provider's own project and user roots resolve from the host's cwd and HOME, which in a tenant host name directories unrelated to the tenant — the session cwd is a container path that does not exist on the host — so only `skill-tier`'s three roots are scanned.
- **`skill-tier`** carries `usersRoot: config.tenants.usersRoot` and, when `sandbox.systemRoot` is configured, `systemSkillsDir: join(sandbox.systemRoot, 'skills')` from a `systemSkillsDir(config)` helper that returns `undefined` when the root is unset. The key is omitted rather than passed as `undefined`, so an unconfigured `systemRoot` keeps `skill-tier`'s own `$DSH_HOME` default instead of overriding it with a path built from nothing.
- **`<sandbox.systemRoot>/skills`** is the same tree both container backends mount as the sandbox's system skill layer, so the host-side scan and the in-sandbox mount name one directory.

## Alternatives considered

- **Re-enable `skill-filesystem` with its default roots** — the project root resolves from the session cwd (a container path with no host counterpart) and the user root from the host HOME, so discovery would scan directories belonging to the harness user rather than the tenant, and could surface one tenant's skill to another. Chosen: `includeDefaultRoots: false` plus the three authoritative roots.
- **Pin the tier roots in the deployment's `cordis.patch.yml`** — the tenant app does not load that profile; its spine is the composition point, and a profile entry would not reach this path at all. Chosen: configure the rows in the spine.
- **Make `usersRoot` and `systemSkillsDir` default inside `skill-tier`** — `skill-tier` cannot know a deployment's `usersRoot`, and its `$DSH_HOME` default is correct for single-user installs. A default that hides a wrong deployment path is the same silent failure this note fixes. Chosen: required supply at the composition point.
- **Fail loud when a tier root is absent** — absence is legitimate (a deployment may run no case-shared skills), so an error here would reject valid configurations. Chosen: keep absence silent at the root, and let the tier precedence rules decide.

## Consequences

**Bought:** a tenant session sees the deployment's system-tier skills — the case run on the deployed host loaded the system-tier report-template skill and drove its scripts — plus the case-shared and user-global tiers at their documented precedence, all resolved from the request's own (tenant, user) authority. Single-user installs are untouched: they never register `ctx.skillTiers` and never compose this spine.

**Cost and deferred work:** the tenant app now states the system root in two places that must agree — `sandbox.systemRoot` here and whatever the container backend mounts as the sandbox system layer; a deployment that changes one and not the other gets a catalog that lists skills the sandbox cannot read. The system tier remains read-only by convention, not enforcement.

### Verification

`tsc -b packages/tenant/tenant-app/tsconfig.json` passes, and `npx tsx scripts/run-oxlint.ts packages/tenant/tenant-app` reports no new findings (4 pre-existing errors, 0 warnings). `packages/tenant/tenant-app/tests/app.spec.ts` covers the spine rows: the `skill-filesystem` row is present and un-disabled with `includeDefaultRoots: false`, and the `skill-tier` row carries `usersRoot` plus `systemSkillsDir` when `sandbox.systemRoot` is set and omits the key when it is not; 31 tests pass. The deployed closed loop on `192.168.138.130` is the end-to-end evidence: before the change the run reached no system-tier skill, after it the run read the skill body and executed its scripts.

## Related

The tier mechanism itself — precedence, ranks, `trustedHost` on discovery and load — is [2026-08-26](2026-08-26-multi-tenant-skill-tier-supply.md) and is unchanged here; this note records only the tenant app's supply of its roots. The sandbox side of the same three roots is [2026-10-08](2026-10-08-sandbox-skill-tiers-are-mounts.md), which mounts `<systemRoot>/skills` as `/opt/data/skills/system` — the host-side scan here must name that tree identically, which is the coupling the Consequences section records. The `$DSH_HOME` fallback that makes an unsupplied `systemSkillsDir` land off-tree is [2026-07-24](2026-07-24-single-harness-home-resolver.md).
