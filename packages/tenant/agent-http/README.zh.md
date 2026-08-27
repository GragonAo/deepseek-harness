# @deepseek-ai/dsh-agent-http

[English](README.md) | 中文

多租户 agent HTTP 载体（`ctx.agentHttp`）：一个无状态的 Request → Response 函数，用持有者令牌鉴权和请求作用域租户 + 用户权威包裹单用户网关（[`@deepseek-ai/dsh-host-apiproxy`](../../host/apiproxy/README.md)）。每个请求先经 `ctx.tenantAuth` 校验凭证、再经 `ctx.tenants.resolveMember` 解析租户并检查成员资格，进入 `runWithTenant` + `runWithUser` 后才把整个请求委托给 `toFetchHandler(ctx.apiProxy)`，于是网关 RPC 背后的租户/用户作用域 provider（`session-persistence-postgres`、`subprocess-container`、`fs-container`、`container-docker`）都在 `requireTenant()` / `requireUser()` 内解析。因共享网关会暴露每个进程内会话，载体还会把 `session.list`/`session.search` 与 `events.mux`/`events.host` 上的会话作用域帧限定到环境 `(tenant, user)` 的会话。一张活跃会话归属映射 `sessionScopes`（由 `session/created` 在环境 `currentTenant()` + `currentUser()` 下喂入，`session/disposed` 时释放）支撑 `owns(sessionId, tenant, user)` —— 对冷会话或匹配的活跃归属返回真 —— 两处过滤都经它完成。

载体不持有任何 agent 或会话状态。当存在 `webServer` 服务时，载体自行注册 `/api` 前缀路由——一个取代单用户 `client-connection` 信任围栏的 node:http fetch 桥，因此 `dsh web` 无需额外适配器即可对外提供多租户 API。鉴权与租户解析在任何方法运行前即失败关闭：`TenantAuthError` 返回带 `WWW-Authenticate: Bearer` 的 401，`TenantError`（`TENANT_UNKNOWN`/`TENANT_DISABLED`/`NOT_A_MEMBER`）返回 403，其余异常记录日志后返回 500。

## 模型体验

无——该包只对一次网关请求做鉴权与作用域限定，任何内容都不触达模型请求。

#### KV 缓存效应

无——该包既不组装也不发送 provider 请求。

## 已知局限与后续工作

- **主机平面帧（无会话 id）原样放行。** 两条下行上的会话作用域帧——mux 流加上 `host/session-added|removed|status|agent-error` 与 `host/archived-sessions-changed`——已限定到环境 `(tenant, user)`，但主机流的 `host/workspace-*` 快照与 `remote-event` 允许清单（`agent-preset/selected`、`commands/change`、`credentials/updated`、`settings/document-updated` 等）携带的是共享主机组合而非任何 `(tenant, user)` 的会话，故原样转发。
