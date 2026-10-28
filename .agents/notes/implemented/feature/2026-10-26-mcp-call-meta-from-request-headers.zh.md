# Agent Note: MCP 调用携带入站请求上下文

Status: implemented

[English](2026-10-26-mcp-call-meta-from-request-headers.md) | 中文

## Problem

按调用方鉴权的 MCP 服务器从 `params._meta` 里取调用方身份与案件。ICAC 案件服务器在这对值不对时回 `403 用户无权限查看该案件`，字段缺失时把 `identity_source` 记成 `none`、`case_id`/`user_id` 留空。桥接层此前只发 `params: { name, arguments }`，于是每次调用都以服务器自己的服务账号、无案件上下文抵达：一个身份服务所有租户用户，没有可审计的按用户隔离。

两条显而易见的通道都传不了它。服务器不读入站 HTTP 请求头（在运行中的服务器上验证过：`X-User`/`X-Case`/`Authorization` 都不改变 `mcp_call_log`），而 `mcpServers[].headers` 是加载时固定的连接级常量，无法按调用方区分。

## Decision

三处改动，一个机制：

- `@deepseek-ai/dsh-tenant` 增加 `runWithRequestHeaders(headers, fn)` / `currentRequestHeaders()`——与已有的租户、用户、scope 权威并列的模块级 `AsyncLocalStorage`。
- `@deepseek-ai/dsh-tenant` 的载体（`@deepseek-ai/dsh-agent-http`）在它本就建立作用域的那一段包上入站请求头（键名小写）。工具调用发生在之后的智能体循环里，但与触发它的那次请求仍在同一棵异步执行树内，这是该存储在工具调用时可读的原因。
- `@deepseek-ai/dsh-mcp-client` 消费可选的 `ctx.mcpCallMeta` 服务：每次调用读取 `entries()` 并合并进 `params._meta`。没有该服务就不发 `_meta`——不需要这条通道的集成逐字节不变。
- `@deepseek-ai/dsh-tenant-app` 由 `mcpMeta.fromHeaders`（`_meta` 键 → 请求头名）提供它，只在配置存在时挂载。映射到、但这次请求没带的头会被省略而不是以空串上送，服务器因此能区分「这次没带案件」与「案件是空串」。

映射写在部署配置里而不在代码里：哪个头承载用户或案件，是调用方与该服务器之间的事实。

## Alternatives considered

- **静态 `mcpServers[].headers`**：否决——每条服务器一个值、所有用户共用，正是要修的局限。
- **在工具执行器里读 `request.headers`**：否决——那里没有请求；循环独立于入队那次回合的 HTTP 调用运行，只有载体看得到请求。
- **把请求头作为事件持久化到会话**：否决——每个请求一条事件会撑大日志，只为下一次调用需要的数据，且让请求头变成没有保留规则的持久状态。
- **每次调用重建带动态 `requestInit` 的传输**：否决——MCP SDK 在建立连接时固定传输头，逐调用重建连接比这次调用本身更贵。
- **把上下文当工具参数传**：否决——模型会看到、也能自己写身份，而且每个工具 schema 都得声明它。

## Consequences

- 身份、案件与其它调用方上下文现在随每次调用抵达服务器，它的鉴权与审计看到真实调用方，而不是服务账号。
- 外发的集合就是部署映射的那几个；调用方发了但映射未列的头不会离开本进程。
- `authorization` 在同一个头集合里，映射它意味着把调用方自己的凭据转给那台服务器。这是调用方的决定、体现在配置里，不是代码的默认行为。
- 服务器若读的是映射没产出的 `_meta` 键，仍以服务账号运行，行为不变且无声——能说清这件事的只有那份配置。
## Testing

`packages/mcp/mcp-client/tests/mcp-client.spec.ts` 证明线路请求：没有注册提供者时不发 `_meta`，注册后下一次调用就带上，且在两次调用之间改变返回值的提供者会被重新读取（按调用解析，而非注册时捕获）。`packages/tenant/agent-http/tests/agent-http.spec.ts` 证明载体在它本就服务的作用域内进入了入站请求头——键名小写、凭据一并在内。`packages/tenant/tenant-app/tests/mcp-meta.spec.ts` 覆盖提供者：头名大小写不敏感匹配、映射到但缺失的头被省略、无请求环境、以及未配置映射。`entries()` 的三个分支都有覆盖，租户作用域的遮蔽与回退行为也有直接断言。
