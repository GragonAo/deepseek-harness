# @deepseek-ai/dsh-mcp-servers-postgres

[English](README.md) | 中文

外部 MCP 服务注册表的 PostgreSQL 介质：`dsh_system` schema 下的两个共享 unit、每份注册表一份缓存，以及写入时执行的配额策略。

它实现 [`dsh-mcp-servers`](../mcp-servers/README.md) 声明的五个原语，于是"什么能存"的规则全部留在那个包里；本包只决定它**存在哪**、一个部署**能存多少**。

## 存储

| unit | 表 | 行 |
| --- | --- | --- |
| `mcp_system_servers` | `server` | 部署级服务，一条一行 |
| `mcp_user_servers` | `server` | 用户自建服务，按 owner 记账 |

两个 unit 都是 **shared**：一个 unit 装下所有租户与所有用户的行，而不是按 owner 分区。这是对通常那条租户隔离规则的刻意反转，也正是"用户的个人 MCP 服务跟着人跨案件走"得以成立的原因——按分区建表会把行绑死在创建它的那个案件上。两份清单在构造上互斥：管理员写 `mcp_system_servers`，用户写 `mcp_user_servers`，任一侧的方法都够不到另一张表。

`mcp_system_servers` 参与全局版本号：一次写入报告新版本号，带着过期 `expectedRevision` 的写入会被 `McpServerRevisionConflict` 拒掉，而不是覆盖另一位管理员的改动。用户那份每行只有一个写者，所以是后写覆盖，不带版本号。

## 配置

```yaml
- name: '@deepseek-ai/dsh-mcp-servers-postgres'
  config:
    maxSystemServers: 32     # quota on the deployment-wide list
    maxUserServers: 8        # quota per user
    allowPrivateHosts: true  # whether a row may point at loopback/private ranges (both registers)
```

`allowPrivateHosts` 对两份清单和连通性测试是同一条策略：能在界面上测通的端点，就是这个部署能存下来的端点。只有公网的部署把它设为 false。

## 启动

`[Service.init]` 加载系统注册表**并**一遍预载所有用户注册表，于是任何用户的第一个会话都不必为首次挂载付一次读。`refreshUsers()` 整表重读；此后读走缓存、写会保持缓存最新。

## Model Experience

Indirectly, through dsh-mcp-external, which mounts the rows this medium persists.

#### KV Cache effect

没有直接开销。一次写入改变的是每个运行中会话下一步挂哪些服务，那部分前缀影响由 `dsh-mcp-external` 说明。

## 已知限制与延后项

- **租户共用两张表。** 这正是本特性的意图，但它意味着在数据库层读 `mcp_user_servers` 会看到每个用户的端点与头名。请把该 schema 的读权限视同密钥库的读权限。
- **头值是明文列。** 必须原样重放给端点，所以不能哈希。
- **用户被删除时不会清理他那些行。** 没有遍历全表回收的路径；需要的话由部署方补。
- **`refreshUsers()` 是整表读。** 数百用户没问题；上万用户应改成"首次用到时按 owner 读"。
- **没有跨实例通知。** 两个宿主进程共用一个数据库时，只能在下一次加载看到对方的写入，不是即时可见。
