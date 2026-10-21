# @deepseek-ai/dsh-agent-http

多租户 agent HTTP 载体（`ctx.agentHttp`）：一个无状态的 Request → Response 函数，用持有者令牌鉴权和请求作用域租户 + 用户权威包裹单用户网关（[`@deepseek-ai/dsh-host-apiproxy`](../../host/apiproxy/README.md)）。每个请求先经 `ctx.tenantAuth` 校验凭证并拒绝未能证明任何租户的凭证，再经 `ctx.tenants.resolveMember` 解析租户并检查成员资格，进入 `runWithTenant` + `runWithUser` 后才把整个请求委托给 `toFetchHandler(ctx.apiProxy)`，于是网关 RPC 背后的租户/用户作用域 provider（`session-persistence-postgres`、`subprocess-container`、`fs-container`、`container-docker`）都在 `requireTenant()` / `requireUser()` 内解析。因共享网关会暴露每个进程内会话，载体还会把 `session.list`/`session.search` 的条目限定到环境 `(tenant, user)` 拥有的会话，并滤掉本租户已归档的会话——归档为之后的取消归档保留了注册表席位，但列表继续显示它就是把租户已经收起来的会话再端出来——同时把 `events.mux`/`events.host` 上的会话作用域帧限定到环境 `(tenant, user)` 的会话，并把每个按 `sessionId` 寻址的 RPC 方法（`session.history`、`session.prompt`、`session.models`、`session.selectModel`、`session.rename`、`session.fork`、`session.attachment`、`session.updateQueue`、`session.cancel`、`session.delete`）在交给网关**之前**先判归属：不属于环境 `(tenant, user)` 的一律以 `session-not-found` 应答，绝不进入共享 agent 注册表。归属判据有两条：载体观察到的活跃归属（`sessionScopes`，由 `session/created` 在环境 `currentTenant()` + `currentUser()` 下喂入，`session/disposed` 时释放）自行裁决——本环境拥有即放行、他人拥有即拒；无活跃归属的 id 必须出现在环境 `(tenant, user)` 的持久记录中（`session-persistence-postgres` 在该租户自己的 schema 内解析），因此他租户的会话无论是活跃还是冷会话都被拒，载体重启也不会放宽可见范围；没有挂持久化时，未被活跃归属认领的 id 一律拒绝而非放行。

载体不持有任何 agent 或会话状态。当存在 `webServer` 服务时，载体自行注册 `/api` 前缀路由——一个取代单用户 `client-connection` 信任围栏的 node:http fetch 桥，因此 `dsh web` 无需额外适配器即可对外提供多租户 API——并默认提供两个免鉴权的浏览器界面。`GET /openapi.json` 提供生成的 OpenAPI 3.1 文档，`/swagger` 提供 Swagger UI（其静态资源读取自随包携带的 `swagger-ui-dist`）；设置 config `openapi: false` 可同时关闭这两个端点。`GET /console` 提供一个自包含的运维页面——无构建步骤、不加载外部资源——它驱动本载体自身的线协议来运行会话生命周期（`session.*` 加上 `events.mux` 流）、查看或写入按租户隔离的凭据（`credentials.describe`/`.set`/`.unset`），以及配置模型供应商（`llm.providers`、`llm.models`、`llm.discoverModels`，以及对 `llm-pi-ai` 和 `agent-default-model` 的 `settings.update`/`.mutate`）。租户页是例外：该页驱动管理载体的 `/admin` 前缀（`tenants.*`、`members.*`、`users.ensure`——见 [`@deepseek-ai/dsh-tenant-admin-http`](../tenant-admin-http/README.md)），因为租户管理不属于本载体的协议。设置 config `console: false` 可关闭该页面。供应商页写入的路由配置只声明 `apiKeyEnv` 凭据引用，密钥本身经由凭据接缝存放，因此没有秘密进入设置文档。凭据页在构造上就是单向无值的：它只渲染 `CredentialView` 的字段，写入的值提交后不再回显。由于凭据接缝不提供枚举方法，该页以引用名作为输入，而非列出可选项。两个界面都不持有租户数据：控制台只是一个外壳，它发出的每个请求都携带运维者自己的持有者令牌。鉴权与租户解析在任何方法运行前即失败关闭：`TenantAuthError` 返回带 `WWW-Authenticate: Bearer` 的 401，`TenantError`（`TENANT_UNKNOWN`/`TENANT_DISABLED`/`NOT_A_MEMBER`）返回 403，其余异常记录日志后返回 500。管理令牌不享受任何豁免：租户管理由 [`@deepseek-ai/dsh-tenant-admin-http`](../tenant-admin-http/README.md) 在 `/admin` 提供，而携带管理作用域却未指明租户的凭证在这里会被拒绝。

## Model Experience

None, as the package only authenticates and scopes one gateway request; nothing here reaches a model request.

#### KV Cache effect

无——该包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **多副本下尚未落盘的会话会被误拒。** 归属的第二条判据读持久记录，而 `session.create` 与首次落盘之间存在窗口：在副本 A 新建、仍未落盘的会话，若紧接着由副本 B 应答同一 id，会被判为不属于环境 `(tenant, user)` 而以 `session-not-found` 拒绝。单副本部署没有这个窗口。消除它要么创建即落盘，要么让活跃归属在副本之间共享。
- **主机平面帧（无会话 id）原样放行。** 两条下行上的会话作用域帧——mux 流加上 `host/session-added|removed|status|agent-error` 与 `host/archived-sessions-changed`——已限定到环境 `(tenant, user)`，但主机流的 `host/workspace-*` 快照与 `remote-event` 允许清单（`agent-preset/selected`、`commands/change`、`credentials/updated`、`settings/document-updated` 等）携带的是共享主机组合而非任何 `(tenant, user)` 的会话，故原样转发。
