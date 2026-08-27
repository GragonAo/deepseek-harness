# Agent Note: Multi-tenant four-tier configuration supply, with per-user runtime override

Status: implemented

English | [中文](2026-08-26-multi-tenant-config-tier-supply.zh.md)

## Problem

The multi-tenant carrier already isolates files, memory, and containers per `(tenant, user)`, and supplies skills and tools from layered directories, but configuration was still flat. A settings namespace resolved from schema defaults, the registering plugin's composition `base`, and the per-`(tenant, user)` PostgreSQL document, with no operator-readable config tier between the composition base and the runtime document and no way for a case or platform to pin a value on disk without editing a patch file. The four tiers had to layer same-named value nearest-tier-wins, distinct keys union — session > case > user-global > system — while the runtime user settings stayed in PostgreSQL per `(tenant, user)` as the final, highest override (the order [2026-08-04](2026-08-04-configuration-source-ownership.md) fixes: user settings above composition).

## Decision

Add a four-root config carrier and read it inside the settings Service Definition, one layer below the runtime document.

- **`@deepseek-ai/dsh-settings-tier`** registers the optional `ctx.settingsTiers` service state-free, mirroring `ctx.skillTiers`/`ctx.toolTiers`. `roots()` reads ambient authority and returns the config directories nearest-tier-first: session (rank 20) `<sessionCwd>/config`, case (rank 30) `<tenant.workspaceRoot>/shared/config`, user-global (rank 40) `<usersRoot>/<sub>/config`, and system (rank 50) `$DSH_HOME/system/config` (`systemConfigDir` config). Every root is `trustedHost: true`, a host path outside the tenant container. `merged(ns)` reads `<root>/<ns>.yaml`, `<root>/<ns>.yml`, then `<root>/<ns>.json` (ENOENT → absent), parses each into a plain object, and deep-merges the roots system→user-global→case→session, so a nearer value wins per key and distinct keys union.
- **`@deepseek-ai/dsh-settings`** exports `SESSION_CONFIG_RANK` `20`, `CASE_CONFIG_RANK` `30`, `USER_GLOBAL_CONFIG_RANK` `40`, `SYSTEM_CONFIG_RANK` `50`, the `SettingsTierKind`/`SettingsTierRoot`/`SettingsTierProvider` types, and the `settingsTiers?` Context augmentation, mirrored from the tool/skill rank surface. `SettingsProvider.resolve` and `mergeLayers` are exported so a carrier shares the exact merge semantics; `resolve` now layers `schema(mergeLayers(mergeLayers(base, tier(ns)), section))` — schema defaults, then the composition `base`, then the merged tier document, then the per-`(tenant, user)` runtime document, which stays highest. `tier(ns)` reads `this.ctx.get('settingsTiers')?.merged(ns)` and every provider runs the same path.
- **The session tier collapses to the tenant workspace root until sessions carry their own cwd**: `ambientSessionCwd` reads the initiating agent's `session.header.cwd` and falls back to `tenant.workspaceRoot`, because every session of a tenant shares that root today.
- **Tier files re-read at resolution points, not per read**: registration, a `(tenant, user)` scope activation, and a document publish re-read the files, so a disk edit lands on the next such point — the same cadence as the tool manifest loader. A malformed tier file fails registration loudly; a later disk edit keeps the namespace's last good value through the existing commit guard.

## Alternatives considered

- **Fold the merged tier document inside the PostgreSQL document.** Rejected: that would flatten an operator-managed disk source into a user-writable document, so a case or platform could not change config without the model writing it back, and credentials would be tempted into the document instead of refused.
- **Read the tier files only in the settings-file provider.** Rejected: the per-`(tenant, user)` runtime document lives in `settings-postgres`, not the file provider; the tier merge belongs in the Service Definition so every provider (file, postgres, memory) layers the same way.
- **Make the session tier a directory under `shared/config`.** Rejected: a session tier inside the case-shared directory cannot vary per session without stuffing a session id into a path shared by every session of the tenant; the session cwd is the one persistent per-session disk anchor and collapses to the workspace root today, recorded below.

## Consequences

**Bought:** a settings namespace now resolves from schema defaults, the composition base, the system config directory, the user-global directory, the case shared directory, and the session directory, then the PostgreSQL per-`(tenant, user)` document (highest); same-named values layer nearest-tier-wins while distinct keys union, and one `<ns>.yaml` file can override a single key without replacing the namespace's other keys. The skill/tool/script tiers merge whole named entries by directory; config merges by key into the one namespace file.

**Cost and deferred work:** the session tier collapses to the workspace root until sessions carry their own cwd; the synchronous host read at registration, scope activation, and publish is fine for a small namespace set, and a per-`(scope, ns, mtime)` warm cache is deferred.

### Verification

`tsc -b tsconfig.host.json` (full host face) passes. `dsh-settings` adds `tier.spec.ts` (defaults < base < tier < document, and tier re-inheritance after `replace(ns, {})`); `settings-tier` ships seven unit tests over root resolution, scope omission, deep-merge, empty, and scalar rejection plus one real-composition integration test over real directories proving document > session > case > user-global > system > base. `bundle/multi-tenant` asserts the `settings-tier` mount and its `DSH_USERS_ROOT` config pin. `verify-cordis-config`, `verify-package-invariants`, `verify-package-readme-model-experience`, `verify-package-readme-limitations`, `verify-export-jsdoc`, and `verify-translation-pairing` all pass. On `192.168.138.130` the composed `--dump-config` shows the `settings-tier` row, a config RPC loop passes 6/6 (session > case > user-global > system over base; PostgreSQL document highest; user-1@beta resolves user-global; user-2@acme resolves session with no user-global layer), and the 12/12 session-isolation regression stays green.