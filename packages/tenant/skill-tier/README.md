# @deepseek-ai/dsh-skill-tier

English | [中文](README.zh.md)

Resolves the current (tenant, user) scope into three host skill directories for the multi-tenant carrier's filesystem skill provider: the case tier `<tenant.workspaceRoot>/shared/skills`, the user-global tier `<usersRoot>/<sub>/skills`, and the system tier (default `$DSH_HOME/system/skills`). The plugin registers the optional `ctx.skillTiers` service; [`dsh-skill-filesystem`](../../skill/skill-filesystem/README.md) reads it on every discovery and appends the three roots ranked case < user-global < system, so a same-named nearer tier wins while distinct names union. All three roots are host paths outside the tenant container, and the provider marks them trusted host so discovery uses host I/O rather than the container-scoped file service.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-skill-tier'
  config:
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip the user-global tier
    # systemSkillsDir: '/root/.dsh/system/skills'  # optional; defaults to $DSH_HOME/system/skills
```

## Model Experience

Indirectly, through dsh-skill-filesystem and dsh-tool-skill: the tier roots only extend which skills are discoverable, and those skills are rendered by the skill tool.

#### KV Cache effect

None directly; each discovered skill consumes the same Skill Summary slot every provider-backed skill uses.

## Known Limitations and Deferred Work

- **The case and user-global tiers need an active (tenant, user) scope.** Directory resolution reads the ambient tenant and user authority on each `roots()` call; a host-side caller without a scope can only see the system tier.
- **The system tier is read-only by convention, not enforcement.** This package supplies its path and rank but does not block writes; deployment owns creating that directory and keeping it const.