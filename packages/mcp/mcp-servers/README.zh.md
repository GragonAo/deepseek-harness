# @deepseek-ai/dsh-mcp-servers

[English](README.md) | 中文

外部 MCP 服务注册表：管理员或用户可以为第三方 MCP 端点存什么，以及两份注册表如何合并成一个会话要挂载的集合。

本包只承载契约与规则，不承载介质。`McpServerStore` 是挂在 `ctx.mcpServers` 上的抽象 `Service`；提供方（[`dsh-mcp-servers-postgres`](../mcp-servers-postgres/README.md)）实现五个原语——各读一次、各整体替换一次、报告系统版本号——所有"什么能存"的判断都留在这里，第二个提供方不会因为实现不同而放宽校验。

只表示 Streamable HTTP 端点。`stdio` 意味着在宿主机上起一个进程，而这正是配置界面绝不能交出去的能力，所以解析器直接拒收能表达它的字段（`command`、`args`、`cwd`、`env`、`transport`）。

## 两份注册表，一种形状

- **system** —— 部署级，管理员维护。按自己的 `serverName` 挂载。
- **user** —— 每个用户一份。按 `u_<sha256(owner)[0:8]>__<serverName>` 挂载，两个人配同名服务不会互相遮蔽，而且工具名里看得见归属。

`effectiveServers(system, mine, userId)` 就是会话消费的那次合并：先所有启用的系统条目，再该用户所有启用的条目，每条带上 `origin`、`ownerId` 与它实际挂载用的 `mountName`。停用的条目在合并时就丢掉，而不是等到挂载时才丢，所以调用方读到的清单与一次会话拿到的完全一致。

## 校验

`parseServerRecord(raw, where, { allowPrivateHosts })` 是唯一一道门。它把头归一成空 map、把 `timeoutMs` 收敛到 1…600000、把 `descr` 限制在 500 字以内，并拒收回环、私网段、运营商级 NAT、链路本地、组播/保留段以及云元数据端点。

`allowPrivateHosts` 对两份清单是同一条策略，默认允许：配服务的人就是用它的人，自建服指向内网端点对用户条目和管理员条目一样正常。需要"只许公网"的部署把它设为 false，两份清单一起遵守——所以不会出现"连通性测试能过、保存却被拒"。

这是一次**静态**主机检查。解析到私网地址的域名在这里查不出来；连接时复查属于延后项，列在下文"已知限制"里。

## 探测草稿条目

`probeMcpServer(url, headers, { allowPrivateHosts, timeoutMs })` 走完一次 MCP 握手（initialize → `notifications/initialized` → `tools/list`，最多跟五页游标），回报 `{ ok, toolsSupported, toolCount, latencyMs, error }`。它不注册任何东西、不导入任何工具，并且既能读 JSON 应答，也能读事件流里 `data:` 帧。

连接失败是一个**答案**（`ok: false`），不是异常。只有地址被拒才抛，因为那是策略拒绝，不是端点说的话。想在动网络之前先判地址的调用方可以直接用导出的 `assertProbeAddress`。

## Model Experience

Indirectly, through dsh-mcp-external, which mounts these rows and hands them to dsh-mcp-client.

#### KV Cache effect

没有直接开销。注册表写入改变的是每个运行中会话下一步要组装的工具清单，随之而来的那一次前缀失效由 `dsh-mcp-external` 说明。

## 已知限制与延后项

- **只有静态主机检查。** `isBlockedHost` 按字面匹配；解析到私网地址的域名能通过。连接时重新解析并拒绝连接属于延后项。
- **没有个人停用清单。** 用户能加自己的服务，不能关掉系统的。"这个用户拿到什么"因此只需答两份清单，而不是三份。
- **连接头明文存储。** 它必须原样重放给端点，所以不能哈希；脱敏是呈现层规则（视图只暴露头**名**），不是存储层规则。
- **版本号只保护系统注册表。** 用户那份只有一个写者，后写覆盖是对的，因此对它忽略 `expectedRevision`。
- **配额是按存储而非按操作。** `maxSystemServers` / `maxUserServers` 在写入时生效；用户被删除时不会回收空间。
