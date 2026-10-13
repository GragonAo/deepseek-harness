# @deepseek-ai/dsh-tenant-admin-http

租户管理载体（`ctx.tenantAdminHttp`）：由 `ctx.tenantAdmin`（[`@deepseek-ai/dsh-tenant-admin`](../tenant-admin/README.md)）持有的管理面，挂在它自己的 `/admin` 前缀下，仅以管理作用域作为准入条件。它注入 `webServer`、`tenantAuth` 与 `tenantAdmin`；注册一条指向 `/admin` 的 `prefix` 路由，并默认注册一条 `exact` 路由，在 `GET /admin/openapi.json` 提供线协议参考。

## 授权

载体不解析租户、不校验成员身份。一个请求 = `POST /admin/<method>`，载荷即其 JSON 请求体；凭据必须携带管理作用域（默认 `dsh:tenant-admin`），而方法自身的载荷指明它作用于哪个租户。每个方法都在 `runWithScopes(principal.scopes, …)` 内运行，因此 `ctx.tenantAdmin` 自己的 `requireScope` 会在触碰任何记录前重新校验同一作用域。

平台凭据不需要任何租户，这正是分域的意义：一个只声明 `sub` + `scope` 的持有者令牌被认证为平台主体，运维者因此不必先被某个租户接纳，才能管理所有租户。业务面（[`@deepseek-ai/dsh-agent-http`](../agent-http/README.md) 的 `/api`）承载相反的授权：它通过 `ctx.tenants.resolveMember` 解析租户并校验成员身份，并拒绝未证明任何租户的凭据。

`/admin` 是固定前缀而非配置项：线协议参考、`/console` 的租户页与本文件指向同一个字面量。

## 方法

| 方法 | 载荷 | 返回值 | 作用 |
|---|---|---|---|
| `tenants.list` | `{}` | `{ items }` | 全部已注册租户，含已禁用者。 |
| `tenants.get` | `{ id }` | tenant | 单条记录，含已禁用者。 |
| `tenants.create` | `{ id, name, dataRoot, workspaceRoot, toolsRoot?, network?, members? }` | tenant | 创建存储分区与宿主目录、注册、持久化。 |
| `tenants.update` | `{ id, name?, workspaceRoot?, toolsRoot?, network? }` | tenant | 修改可恢复的元数据；`id` 与 `dataRoot` 不可变。 |
| `tenants.enable` / `tenants.disable` | `{ id }` | tenant | 翻转 `resolve` 对租户请求施加的启用闸门。 |
| `tenants.remove` | `{ id, purge? }` | `{ removed: true }` | 删除记录；`purge` 同时清除分区并归档宿主目录。 |
| `members.list` | `{ id }` | `{ members }` | 该租户已接纳的主体。 |
| `members.add` | `{ id, subject }` | `{ members }` | 接纳一个主体，并创建其沙箱要挂载的宿主目录。 |
| `members.remove` | `{ id, subject }` | `{ members }` | 撤销接纳；已存数据与目录保留。 |
| `users.ensure` | `{ subject }` | `{ root }` | 预建某个主体的 `/global` 分层目录，不属于任何租户。 |
| `skills.list` | `{ tier }` | `{ tier, directory, entries }` | 某个环境技能层的目录清单，逐条给出是否可加载与不可加载的带码原因。 |
| `skills.upload` | `{ tier, zip, replace? }` | `{ tier, name, directory, replaced, files, visible }` | 上传一个技能包（`zip` 为 base64 的 zip），校验后原子换入；`replace` 允许覆盖同名技能。 |
| `skills.remove` | `{ tier, name }` | `{ tier, name, directory, visible }` | 删除某个已安装技能，`name` 可用目录名或 frontmatter 名。 |

`tier` 取 `case`、`user-global`、`system` 之一，实际可写的层由当前请求作用域发布的技能层决定：平台管理令牌没有租户与用户，因此只能写系统层。三个 `skills.*` 方法由 [`@deepseek-ai/dsh-skill-install`](../../skill/skill-install/README.md)（`ctx.skillInstall`）执行，每次变更后由它刷新进程级技能目录缓存，`visible` 即刷新后的目录是否列出该技能。

## 响应

每个应答都是一个信封：`200 { ok: true, value }`，或 `{ ok: false, error: { code, message, details? } }`。

| 状态码 | 代码 | 原因 |
|---|---|---|
| 400 | `bad-request` | 请求体不是 JSON，或载荷未通过其 schema（zod 问题在 `details.issues`）。 |
| 400 | `tenant-invalid` | `ctx.tenantAdmin` 拒绝了某个输入（不安全的路径段、缺少字段）。 |
| 401 | `MISSING_CREDENTIAL` / `INVALID_TOKEN` | 无持有者令牌，或令牌无法验证。同时返回 `WWW-Authenticate: Bearer`。 |
| 403 | `tenant-forbidden` | 令牌验证通过但缺少管理作用域（`details.scope`）。 |
| 404 | `tenant-not-found` | 该 id 下没有已注册租户。 |
| 404 | `unknown-method` | 该名称下没有已注册的管理方法。 |
| 405 | `method-not-allowed` | 用 POST 以外的方式访问某个方法；同时返回 `Allow: POST`。 |
| 409 | `tenant-conflict` | 该 id 的租户已存在。 |
| 400 | `bundle-invalid` / `bundle-unsafe-entry` | `skills.upload` 的 zip 不可读、条目重复、有多个或没有根 `SKILL.md`，或某个条目不是包内相对路径。 |
| 400 | `skill-invalid` | 技能文档无法加载：`details.issues` 逐条给出 `code` 与 `line`。 |
| 404 | `skill-absent` | 该技能层里没有这个名字的技能。 |
| 409 | `skill-exists` / `skill-ambiguous` | 同名技能已存在且未允许覆盖；或有两个目录注册同一个名字，无法判定删哪个。 |
| 413 | `request-too-large` | 请求体超过 `maxRequestBodyBytes`（`skills.upload` 用 `maxUploadBodyBytes`）。 |
| 413 | `bundle-too-large` | 技能包解压后超过 `@deepseek-ai/dsh-skill-install` 的 `maxExpandedBytes`。 |
| 503 | `skill-install-unavailable` | 组合里没有挂载 `@deepseek-ai/dsh-skill-install`，`skills.*` 无执行者。 |
| 503 | `tier-unavailable` | 该请求作用域没有发布要写的那个技能层。 |
| 500 | `tenant-provision-failed` | 存储或某个宿主目录步骤失败。 |
| 500 | `internal` | 其他异常，已记入日志。 |

## 配置

```yaml
- id: tenant-admin-http
  name: '@deepseek-ai/dsh-tenant-admin-http'
  config:
    adminScope: dsh:tenant-admin
    maxRequestBodyBytes: 1048576
    maxUploadBodyBytes: 33554432
    openapi: true
```

`adminScope` 必须与 `tenant-admin` 行所钉的值一致：载体进入该作用域、服务再校验它，因此两侧配置不同值会让每个请求都被拒绝。`maxRequestBodyBytes` 默认 1 MiB——除技能包之外的管理载荷只声明 id、主体与宿主路径、不携带内容，与业务面的聚合镜像预算不同。`maxUploadBodyBytes` 默认 32 MiB，只作用于 `skills.*`：技能包以 base64 装在 JSON 里，这个上限比包本身大三分之一，并且高于 `@deepseek-ai/dsh-skill-install` 默认的包体上限。`openapi: false` 关闭线协议参考。

## Model Experience

None, as the management carrier answers HTTP requests over ctx.tenantAdmin; neither it nor the operations it serves reaches a model request.

#### KV Cache effect

无；本包既不组装也不发送供应商请求。

## Known Limitations and Deferred Work

- **`/console` 页面的租户页是唯一已交付的客户端。** [`agent-http`](../agent-http/README.md) 提供该页面，而本包持有它调用的方法，因此该页依赖两者同时挂载；只挂载本载体而不挂载 `agent-http` 的部署有协议参考、没有界面。
- **管理文档没有 Swagger UI。** `GET /admin/openapi.json` 提供文档；可交互浏览仍留在业务面的 `/swagger`，它只描述 `/api`。
- **一个管理令牌即拥有整个管理面。** 管理作用域准入全部 14 个方法——没有只读或按方法划分的作用域，`ctx.tenantAdmin` 的粒度与之相同。
- **技能包只能装在系统层。** 平台令牌不证明任何租户与用户，`ctx.skillTiers` 在那个作用域下只发布系统层，所以 `skills.upload` 写不进案件层与用户全局层；为某个租户装技能需要一个指明租户的调用路径，本管理面不提供。
- **上传走 base64 JSON，没有分片或流式通道。** 技能包整个读进内存再解包，`maxUploadBodyBytes` 因此同时是并发上传的内存上限；`multipart/form-data` 或直接传 zip 的通道尚未提供。
- **`users.ensure` 创建的是目录，不是用户。** 主体只有在成为某个租户的成员后才可被寻址；其 `/global` 分层同样由 `members.add` 创建；把用户管理作为一等资源不属于本管理面。
