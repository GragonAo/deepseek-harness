# @deepseek-ai/dsh-tools-tier

English | [中文](README.zh.md)

Resolves the current (tenant, user) scope into three host tool-manifest directories for the multi-tenant carrier's declarative tool loader: the case tier `<tenant.workspaceRoot>/shared/tools`, the user-global tier `<usersRoot>/<sub>/tools`, and the system tier (default `$DSH_HOME/system/tools`). The plugin registers the optional `ctx.toolTiers` service; the tool-manifest loader reads it and merges the three roots ranked case < user-global < system, so a same-named nearer tier wins while distinct names union. All three roots are host paths outside the tenant container, and the provider marks them trusted host so the loader reads them with host I/O rather than the container-scoped file service.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-tools-tier'
  config:
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip the user-global tier
    # systemToolsDir: '/root/.dsh/system/tools'  # optional; defaults to $DSH_HOME/system/tools
```

## Model Experience

Indirectly, through the declarative tool loader, which turns each manifest into a tool the tool registry presents to the model.

#### KV Cache effect

None directly; each manifest-declared tool consumes the same tool-schema slot every registered tool uses.

## Known Limitations and Deferred Work

- **The case and user-global tiers need an active (tenant, user) scope.** Directory resolution reads the ambient tenant and user authority on each `roots()` call; a host-side caller without a scope can only see the system tier.
- **The system tier is read-only by convention, not enforcement.** This package supplies its path and rank but does not block writes; deployment owns creating that directory and keeping it const.