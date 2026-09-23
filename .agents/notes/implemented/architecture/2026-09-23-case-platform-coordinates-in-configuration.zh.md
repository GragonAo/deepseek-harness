# Agent Note: 案件平台的坐标全部落在配置里

Status: implemented

[English](2026-09-23-case-platform-coordinates-in-configuration.md) | 中文

## 问题

案件技能在沙箱里产出报告，案件的业务记录在案件平台那边，二者之间原本没有任何通道。这项能力在 Hermes 部署里存在，但那是个把平台地址写死在源码里的插件——而地址恰恰是各部署之间唯一不同的那个值：DSH 宿主机通过 compose 发布到宿主机的端口访问平台，Hermes 沙箱通过 compose 服务名访问它，两个地址在对方那一侧都解析不了。把地址编进插件，产物就带上了部署属性，而且要到第一次上传才失败，而不是在加载期失败。

同一个平台还能通过 MCP 访问。DSH 部署只挂了它 12 个 serverKey 里的 1 个，于是照 Hermes 部署写的技能只能找到它要调用的分析工具中的一小部分。

## 决定

案件平台的坐标是**可挂载 patch 层里的配置**。没有任何包携带地址。

### 同步工具是一个挂载扩展

业务对接不是 harness 的能力。一个只面向某个部署的案件平台的插件属于那个部署，所以它住在部署方自己持有的目录里，而不是 `packages/`；新增或更新一个工具，就是丢一个文件加一行配置，不需要重建镜像。

目录放在 profile **里面**（`$DSH_HOME/profiles/multi-tenant/plugins/tool-sync-file/`），因为挂载插件 `import` harness 包时走 Node 逐级向上的 `node_modules` 查找，只有从 profile 里面出发才会走到启动器维护的 `$DSH_HOME/profiles/node_modules` 兜底目录。profile patch 用相对 profile 目录（也就是 Loader 的 `baseUrl`）的路径 specifier 指名它，并且必须写在 `insert:` 块里 —— patch 层顶层的 `- id:` 是覆盖已有行，不是新增：

```yaml
- insert:
    - id: tool-sync-file
      name: './plugins/tool-sync-file/index.mjs'
      config:
        serverUrl: http://127.0.0.1:18081
```

它在 jeecg-boot 后端之上注册两个模型可见的工具：

- `sync_file_report` 登记沙箱已经产出的报告，把 `userId`、`caseId`、`fileName` 以及可选的 `template` / `caseName` 以表单形式 POST 到 `<serverUrl>/jeecg-boot/report/upload`，返回平台报告 id，即 jeecg `Result` 信封的 `result` 字符串。平台按案件 id 加文件名在案件卷里定位文件，因此 `file_name` 是文件名而不是路径。
- `sync_file_skill` 通过 `ctx.fs` 读取技战法包（因此路径就是调用方沙箱看到的路径），并以 multipart 表单携带 `typeId`、`userId` POST 到 `<serverUrl>/jeecg-boot/jzf/user/import`。

`Config.serverUrl` 必填且没有默认值。`Config.accessTokenEnv` 是凭据引用（`z.string().role('credential-ref')`，默认 `REPORT_ACCESS_TOKEN`），每次调用通过 `ctx.credentials` 解析，未挂载时回落到启动环境，因此令牌轮换对下一次调用即生效，令牌本身也不是配置。`Config.timeoutMs`（默认 120000）经 `deadline()` 限制单次往返；`Config.maxUploadBytes`（默认 64 MiB）限制读取的包大小。`serverUrl` 或凭据引用不合法时在加载期失败，而不是在第一次调用时。

两个工具都从调用所在的那个已鉴权请求取身份：`case_id` 是 `requireTenant().id`，平台侧的 `userId` 是 `requireUser()`。两个工具都不接受案件 id、用户 id 或服务地址作为参数。任何失败——平台不可达、响应非 2xx、信封返回 `success: false`、返回成功却没带 id——都会变成一个工具失败结果，消息里写明端点与平台自己给出的原因，且永远不带令牌。遇到重定向时拒绝而不是跟随，携带凭据的请求不会被重放到重定向目标上。

### MCP 服务器集合是可挂载 bundle patch 里的一张行表

`packages/bundle/multi-tenant/cordis.patch.yml` 为每个 serverKey 插入一个 `@deepseek-ai/dsh-mcp-client` 实例——`case`、`bill`、`callrecord`、`property`、`relationship`、`trajectory`、`timeline`、`persona`、`specialized`、`doubt`、`import`、`ai-analysis`——每个都带 `serverName: icac-<serverKey>`，因此案件会话在 `mcp__icac-case__*` 之外还能拿到 `mcp__icac-bill__*` 及其同级工具。这一段明确写了它的地址属于部署而不是产品，并列出运维会遇到的两种形态：共享宿主网络的 DSH 宿主机用 `http://127.0.0.1:19830`，容器网络上的用 `http://jeecg-boot-mcp-server:19830`。

## 考虑过的替代方案

**把同步工具做成仓库内包。** Loader 本来就能导入绝对路径，所以 `packages/` 里的一个包也能跑，而且它带有挂载目录没有的全部仓库门禁——JSDoc、invariant 伴生文件、类型检查、测试、依赖清单。它输在运维的约束上：包只能通过镜像到达部署，于是每次改工具都要重建。地址仍然该放在 `Config` 字段里，而挂载插件和包一样能声明它。

**给 `serverUrl` 一个默认值。** 默认地址就是一个会静默指向默认值所命名后端的地址，它产生的失败是一次打到错误后端（或打不到任何后端）的调用。平台发布在哪个端口是 compose 映射，不是产品事实。把该字段设为必填，把这个失败提前到加载期，并且它会指出缺失的字段名。

**像 Hermes 插件那样保留 `case_id` / `user_id` 参数。** 那样模型就能决定一次登记落到哪个案件的记录里，而案件平台自身的鉴权并没有把这些端点按案件隔离。已鉴权请求本来就知道这两个值，所以这些参数唯一的作用就是寻址另一个案件。它们已从 schema 中移除，执行体改为读取请求上的身份。

**把访问令牌作为字面量写进 `Config`。** patch 层里的令牌就是组合里的一个秘密，它会进入日志、diff 和每一个读这个文件的人，轮换一次就得改文件加重载。凭据引用把令牌留在部署本来就挂载的凭据平面里，并且每次调用重新解析。

**让传输异常逃出工具。** 携带 `fetch` 失败或中止原因的异常不是模型能处理的东西，而原始失败路径正是请求体或请求头泄进对话记录的地方。客户端把每一种失败都翻译成一条写明端点与平台原因的消息。

**把 MCP 服务器集合留在部署自己的 profile patch 里。** 它本来就在那里，而且能用——对一个部署而言。这个集合不是秘密，除地址之外也不依赖具体主机，把它挡在仓库外意味着每个部署都要重述 12 行才能拿到案件平台本来就有的工具。这些行现在随层发布，部署 patch 只留真正属于它自己的东西。

## 后果

部署要迁移案件平台，只需改 patch 层里的 `serverUrl` 与 MCP 行地址，不涉及重建镜像。新增或更新一个同步工具也是同一类改动 —— 配置好的插件根里放一个目录，加上它的 `local:` 行 —— 所以挂载插件这项能力是一次性的镜像前提，而不是每个工具一次。

profile patch 里已经插入了任何 `mcp-icac-*` id 的部署，在本层到达它时必须删掉那一行。一个 loader entry id 只能由一个层插入，第二次插入是启动期的 duplicate-id 失败而不是覆盖——因此带上这些行的镜像第一次启动时，若旧的 profile 行还在，会在注册任何工具之前就失败。

插件的两个端点都在案件平台的免鉴权 URL 名单里，所以不配 `REPORT_ACCESS_TOKEN` 是常态，不会发送 `Authorization` 头。在平台前面挂了鉴权网关的部署改为配置该引用。

MCP 客户端不发送平台 MCP 服务器用来读取 `case_id` / `user_id` / `session` 的 `_meta`，因此每个案件都回落到服务端默认值。这是客户端的属性，不是这张行表的属性，此处未改动。

报告是"登记"而不是"上传"。平台的 `/report/upload` 接受可选的 `file` 部分，本插件不发送它，因此平台在案件卷里看不到的报告会在平台侧以平台自己的报错失败。

工具描述里列出的分析类型 id 是平台预置的行。它们只写给模型看，没有与平台校验，因此重新预置过类型表的部署需要自行改写；代码只校验数字形式。
