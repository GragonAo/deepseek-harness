# @deepseek-ai/dsh-tools-tier

[English](README.md) | 中文

把当前 (租户, 用户) 作用域解析为多租户载体声明式工具加载器要用的三个宿主机工具清单目录：案件层 `<tenant.workspaceRoot>/shared/tools`、用户全局层 `<usersRoot>/<sub>/tools`、系统层（默认 `$DSH_HOME/system/tools`）。本插件注册可选的 `ctx.toolTiers` 服务；工具清单加载器读取它，按 case < user-global < system 的 rank 合并这三个根，于是同名者近层胜出、异名者并集。这三个根都是租户容器外的宿主机路径，provider 将其标记为 trusted host，从而用宿主机 I/O 读取，而不是走容器作用域的文件服务。

## 配置

```yaml
- name: '@deepseek-ai/dsh-tools-tier'
  config:
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip the user-global tier
    # systemToolsDir: '/root/.dsh/system/tools'  # optional; defaults to $DSH_HOME/system/tools
```

## 模型体验

通过声明式工具加载器间接生效：加载器把每份清单变成一个由工具注册表呈现给模型的工具。

#### KV 缓存效应

无直接影响；每个清单声明的工具占用任何已注册工具都相同的工具 schema 插槽。

## 已知局限与后续工作

- **案件层与用户全局层需要活跃的 (租户, 用户) 作用域。** 目录解析在每次 `roots()` 调用时读取环境中的租户与用户权威；没有作用域的宿主机侧调用方只能看到系统层。
- **系统层是约定只读，而非强制。** 本包只提供它的路径与 rank，不阻止写入；创建并保持该目录只读由部署方负责。