# Agent Note: Multi-tenant declarative tool supply

Status: implemented

English | [中文](2026-08-26-multi-tenant-tool-manifest-loader.zh.md)

## Problem

The skill tier ([2026-08-26](2026-08-26-multi-tenant-skill-tier-supply.md)) shipped case > user-global > system skill supply, but tools still resolve only through the built-in registry and the fixed tool packages: no tenant, user, or case can add a tool through a file, and there is no same-name precedence layering for tools. The three-tier tool requirement needs the same tool name to resolve nearest-tier-wins (case-shared `/shared` outranks user-global `/global`, which outranks the system tier) with distinct names unioning, and — because the tiers are tenant-authored — must accept only a declarative manifest, never executable code, and must keep credentials out of every mounted directory.

## Decision

Make the tool registry rank-aware, then register one ambient tier service and one data-only manifest loader on top of it.

- **`@deepseek-ai/dsh-tools`** gains `CASE_TOOL_RANK` `30`, `USER_GLOBAL_TOOL_RANK` `40`, and `SYSTEM_TOOL_RANK` `50`, plus an optional `ctx.toolTiers` Context augmentation. Its layer now uses a private `ToolEntries` (per-entry `id`, name-keyed shadow stack) so `register(definition, rank?)` resolves a shared name by rank — lower rank wins, an unranked native registration is lowest precedence (`rank ?? +Infinity`), and disposing an entry restores the shadowed one out-of-order-safe.
- **`@deepseek-ai/dsh-tools-tier`** registers `ctx.toolTiers` as a state-free `Service`: `roots()` reads `currentTenant()`/`currentUser()` and returns the case root `<tenant.workspaceRoot>/shared/tools`, the user-global root `<usersRoot>/<sub>/tools`, and the system root (default `$DSH_HOME/system/tools`), all `trustedHost: true`.
- **`@deepseek-ai/dsh-tools-manifest`** (the loader) registers a global `agent/created` listener that reads `ctx.get('toolTiers')?.roots()`, sorts them system → user-global → case, and registers each manifest into `agent.ctx.tools` at its root's rank. The agent scope's disposal unwinds the registrations.
- **A manifest is data-only**: a kebab-case `name`, a `description`, flat string `parameters` (`type: string`, optional `description`/`required`), a fixed `executor` (`command`, an `args` template with `$field` placeholders, optional `cwd`/`env`), and an optional `timeoutMs`. `defineTool` supplies argument validation and schema projection, so no parameter or executor escapes the validated surface.
- **Execution stays inside the tenant container**: the loader spawns through `ctx.subprocess` — the container provider in the multi-tenant carrier — with a bounded stdout/stderr collect, `graceMs` termination, and a `defaultCwd` (config `defaultCwd`, bundle-pinned to `/workspace`). This is a deliberate divergence from running manifest commands on the host: a tenant-authored case manifest must not escape container isolation.

## Alternatives considered

- **Host-spawn the manifest command** — simplest executor, but a case-tier manifest (tenant-authored) would then run on the host beside other tenants. Rejected: the tenant container is the isolation boundary.
- **`prepare()` warm-up cache** — an async hook that pre-parses the tier directories beats reading them per request, but adds agent-http coupling and a warm-up race. Deferred: the synchronous per-`agent/created` read is fine for a small manifest set.
- **Raw JSON-Schema parameters bypassing `defineTool`** — more expressive but loses argument validation and the registry's schema projection. Rejected: flat string `ValueSchemaSpec` parameters through `defineTool` keep the one validated path.

## Consequences

**Bought:** case > user-global > system tool precedence plus union of distinct names; tier directories resolved from the request's own authority; a tool can be added by dropping one YAML file with no code and no credential surface; manifest commands execute inside the tenant container.

**Cost and deferred work:** parameters are flat string scalars only (the `$field` argv substitution admits no richer shape yet); manifests are re-read synchronously per agent creation; and the 4-tier configuration supply plus the deployed `192.168.138.130` closed-loop turn remain the next slices.

### Verification

`tsc -b tsconfig.host.json` (full host face) passes. The rank test in `dsh-tools` proves a ranked tier registration shadows a same-named unranked native and restores on disposal. Four `tools-manifest` tests cover manifest parsing, `case > user-global > system` precedence with union, and an in-subprocess executor call; the `agent/created` hook is exercised through a real boot (session, tools, subprocess-local, agent registry, tier provider). `bundle/multi-tenant` asserts the `tools-tier` + `tools-manifest` mounts and their config pins. `verify-cordis-config`, `verify-package-invariants`, `gen-tool-catalog`, `verify-translation-pairing`, and the README Model-Experience/limitations gates all pass.