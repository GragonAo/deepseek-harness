# @deepseek-ai/dsh-skill-tier

把当前 (租户, 用户) 作用域解析为多租户载体文件的 skill provider 要用的三个宿主机 skill 目录：案件层 `<tenant.workspaceRoot>/skills`、用户全局层 `<usersRoot>/<sub>/skills`、系统层（默认 `$DSH_HOME/system/skills`）。本插件注册可选的 `ctx.skillTiers` 服务；[`dsh-skill-filesystem`](../../skill/skill-filesystem/README.md) 在每次发现时读取它，按 case < user-global < system 的 rank 追加这三个根，于是同名者近层胜出、异名者并集。这三个根都是租户容器外的宿主机路径，provider 将其标记为 trusted host，从而用宿主机 I/O 发现，而不是走容器作用域的文件服务。

## 配置

```yaml
- name: '@deepseek-ai/dsh-skill-tier'
  config:
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip the user-global tier
    # systemSkillsDir: '/root/.dsh/system/skills'  # optional; defaults to $DSH_HOME/system/skills
```

## Model Experience

Indirectly, through dsh-skill-filesystem and dsh-tool-skill: the tier roots only extend which skills are discoverable, and those skills are rendered by the skill tool.

#### KV Cache effect

无直接影响；每个被发现的 skill 占用与任何 provider 支撑 skill 相同的 Skill Summary 插槽。

## Known Limitations and Deferred Work

- **案件层与用户全局层需要活跃的 (租户, 用户) 作用域。** 目录解析在每次 `roots()` 调用时读取环境中的租户与用户权威；没有作用域的宿主机侧调用方只能看到系统层。
- **系统层是约定只读，而非强制。** 本包只提供它的路径与 rank，不阻止写入；创建并保持该目录只读由部署方负责。
