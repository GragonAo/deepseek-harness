# @deepseek-ai/dsh-settings-tier

把当前 (租户, 用户, 会话) 作用域解析成四个宿主机配置目录，供多租户载体的设置 Service Definition 使用：会话层 `<sessionCwd>/config`、案件层 `<tenant.workspaceRoot>/shared/config`、用户全局层 `<usersRoot>/<sub>/config`，以及系统层（默认 `$DSH_HOME/system/config`）。本插件注册可选的 `ctx.settingsTiers` 服务；[`dsh-settings`](../../settings/settings/README.md) 在每次解析时读取 `merged(ns)`，把每个命名空间的文件（`<ns>.yaml`/`<ns>.yml`/`<ns>.json`）分层到按 (租户, 用户) 的运行期文档之下，按会话 < 案件 < 用户全局 < 系统 排序（近层胜出），同名值由更近的一层胜出、异名键取并集，PostgreSQL 运行期文档始终保持最高覆盖。会话层取自发起 agent 的 `session.header.cwd`，没有 ambient 会话时回退到租户工作区根。四个根目录都在租户容器外的宿主机上，提供方将其标记为受信宿主机，因此解析走宿主机 I/O 而非容器作用域的文件服务。

## 配置

```yaml
- name: '@deepseek-ai/dsh-settings-tier'
  config:
    usersRoot: '/root/.dsh/users'      # host root of per-subject config dirs; omit to skip the user-global tier
    # systemConfigDir: '/root/.dsh/system/config'  # optional; defaults to $DSH_HOME/system/config
```

## Model Experience

Indirectly, through dsh-settings: the tier roots only change which value a registered settings namespace resolves, and that resolved value is what later reaches model-facing plugins (defaults, prompts, model selection, permissions).

#### KV Cache effect

无直接影响；层值变化会重新解析受影响的命名空间并沿用既有 `settings/updated` 提交路径，不占用新的 KV 槽。

## Known Limitations and Deferred Work

- **会话层与案件层需要激活的 (租户, 用户) 作用域。** 目录解析在每次 `roots()` 调用时读取 ambient 权限；没有作用域的宿主机侧调用方只能看到系统层。
- **在会话拥有自己的 cwd 之前，会话层会坍缩到租户工作区根**，因为当前同一租户的所有会话共享该根目录。
- **层文件在解析时重读，而非每次读取都重读。** 注册、作用域激活与文档发布会重读文件；磁盘上的改动在下一个此类时点生效。
- **系统层按约定只读，而非强制。** 本包只提供其路径与 rank，不阻止写入；创建该目录并保持其只读由部署方负责。
