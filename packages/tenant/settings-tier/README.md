# @deepseek-ai/dsh-settings-tier

English | [中文](README.zh.md)

Resolves the current (tenant, user, session) scope into four host config directories for the multi-tenant carrier's settings Service Definition: the session tier `<sessionCwd>/config`, the case tier `<tenant.workspaceRoot>/shared/config`, the user-global tier `<usersRoot>/<sub>/config`, and the system tier (default `$DSH_HOME/system/config`). The plugin registers the optional `ctx.settingsTiers` service; [`dsh-settings`](../../settings/settings/README.md) reads `merged(ns)` on every resolution and layers the per-namespace file (`<ns>.yaml`/`<ns>.yml`/`<ns>.json`) below the per-(tenant, user) runtime document, ranked session < case < user-global < system (nearest tier wins), so a same-named value in a nearer tier wins while distinct keys union and the PostgreSQL runtime document stays the highest override. The session tier resolves from the initiating agent's `session.header.cwd` and falls back to the tenant workspace root when none is ambient. All four roots are host paths outside the tenant container, and the provider marks them trusted host so resolution uses host I/O rather than the container-scoped file service.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-settings-tier'
  config:
    usersRoot: '/root/.dsh/users'      # host root of per-subject config dirs; omit to skip the user-global tier
    # systemConfigDir: '/root/.dsh/system/config'  # optional; defaults to $DSH_HOME/system/config
```

## Model Experience

Indirectly, through dsh-settings: the tier roots only change which value a registered settings namespace resolves, and that resolved value is what later reaches model-facing plugins (defaults, prompts, model selection, permissions).

#### KV Cache effect

None directly; a changed tier value re-resolves the affected namespace and follows the existing `settings/updated` commit path, consuming no new KV slot.

## Known Limitations and Deferred Work

- **The session and case tiers need an active (tenant, user) scope.** Directory resolution reads ambient authority on each `roots()` call; a host-side caller without a scope can only see the system tier.
- **The session tier collapses to the tenant workspace root until sessions carry their own cwd**, because every session of a tenant shares that root today.
- **Tier files are re-read on resolution, not per read.** Registration, a scope activation, and a document publish re-read the files; a disk edit lands on the next such point.
- **The system tier is read-only by convention, not enforcement.** This package supplies its path and rank but does not block writes; deployment owns creating that directory and keeping it const.