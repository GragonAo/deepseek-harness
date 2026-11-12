# @deepseek-ai/dsh-tool-skill-publish

[English](README.md) | 中文

模型侧的 `skill_publish` 工具：把模型已经写好的技能按普通文件交给部署方的管理平台，由平台入库并安装。

要求 `ctx.fs`、`ctx.tools`，以及请求范围内的主体（`inject: ['fs', 'tools']`，主体经 `requireUser()` 取得）。

技能写在模型本来就在写文件的地方——会话工作区。所以发布取的是一个目录，不是内容：插件通过 `ctx.fs` 走完这棵树、校验文档，再把文件作为一个 zip POST 出去。模型写下的东西一个字节都不会穿回这次调用，因此发布一个 200 KB 的技能，花掉的是一个路径的 token，而不是一个归档的 base64。

## 这里不装任何东西

平台同时拥有记录**和**安装。它的技能列表、宿主磁盘上的技能目录、后续会话读到的技能清单，三处必须说的是同一件事，所以写它们的只有一方：平台。平台不认识的技能，就是用户看不见、启不了、停不了、也删不掉的技能——先在本地装一遍，恰好制造出这个插件要消除的那种不一致。

因此只有平台收下了归档，这次发布才算成功；没配目标的部署直接装载失败，而不是接受一堆它没处入档的发布。

## 工具：`skill_publish`

| 参数 | 类型 | 说明 |
|---|---|---|
| `path` | string（必填） | 存放 `SKILL.md` 的目录，相对会话工作目录或绝对路径。 |

这次遍历把 `path` 解析到调用方会话的 `session.header.cwd` 上，所以一个相对目录的含义与模型的文件工具一致。它跳过打包噪声（`.git`、`node_modules`、`__MACOSX`、`.DS_Store`、`._*`），在读取过程中落实 `maxFiles`、`maxFileBytes`、`maxTotalBytes`，遇到非普通文件就拒绝，而不是悄悄丢掉。发送之前先用 `readSkillDocument` 校验文档，所以一份坏掉的 `SKILL.md` 在对话里就被指出来，而不是变成一次平台拒收。

成功时返回 `{ name, fileCount, replaced }`；平台报了它入档的那条记录时再带上 `id`。发布一个库里已有的名字会替换掉那条旧记录——平台删掉重复行，并把新归档覆盖到旧目录上。

## 提交

| 配置 | 类型 | 说明 |
|---|---|---|
| `record` | object（必填） | 给这份技能入档并安装的管理平台。 |
| `record.url` | string（必填） | 接受 `multipart/form-data` 的入库端点。 |
| `record.token` | string（与 `tokenEnv` 二选一） | 以 `x-dsh-ingest-token` 发送的令牌；端点会拒绝不匹配的值。 |
| `record.tokenEnv` | string（与 `token` 二选一） | 存放该令牌的环境变量名，给那些把令牌当 Secret 下发的部署用。只在装载时读一次，所以变量不存在或为空会让装载失败。 |
| `record.timeoutMs` | number | 期限，单位毫秒。默认 `30000`：平台要先落盘归档、再经宿主把它装回去，然后才回话，而冷启动宿主的第一次外连实测超过 10 秒。 |

一次发布把刚打好的归档 POST 过去——`subject`（技能归属的账号，取自请求范围内的主体）、`origin`，以及作为 `file` 的 zip。归档以字节走在请求体里；它的 base64 不会进入对话，模型这次调用里仍然只有一个路径。

对应的服务端是本部署平台的 `POST /dsh/inner/skill/ingest`：它把归档记到账号名下、写入记录，并装进该账号的技能目录；两侧从各自的配置里读同一个共享令牌。那个平台对每个请求都用它自己的信封回话（`{ success, code, message, result: { ok, id, name, userId, replacedRows } }`），并且把拒收——包括令牌不对——报成 HTTP 200 加 `success: false`，所以 2xx 本身不算凭据：插件读信封，`success: false` 或 `result.ok: false` 一律按拒收处理；而 2xx 但响应体不是那个信封时，仍以状态码为准。拒收会带上平台自己的解释——响应体最多 300 字符，对这个端点来说就是运维真正需要的诊断（“令牌不匹配”、“找不到发布者对应的账号”）——所以缺口可以在对话里诊断，而不必去翻平台日志。

`record` 配一半——有 URL 没令牌、令牌写了两次、`tokenEnv` 指向环境里不存在的变量，或任何一个值为空——都在装载时失败，而不是每次发布都失败一次。

## 模型体验

### 工具 schema

#### 模型看到什么

模型看到的是生成的 [`skill_publish` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill-publish)：`path`（必填），描述里说明该目录必须含 `SKILL.md`、目录里的其他文件也会一并发布、内容从不以粘贴或归档的形式进入调用、以及发布一个已有的名字会替换它。

#### Token 影响

工具可见的每个请求上的固定 schema 开销。

#### KV Cache 影响

在工具定义与可见性不变期间前缀稳定。

### 调用历史与结果

#### 模型看到什么

每次调用在参数里保留 `path`——一个路径，绝不是技能内容。成功时返回恰好一句话：`Published the skill "<name>" (<n> files) to the skill library: the platform recorded it and installed it, so the catalog lists it now and a later request can trigger it.` 发生替换时，在引出后果的那个逗号前插入 `, replacing an earlier skill of the same name`。稳定失败各自指明原因与下一步：`There is nothing at <path>. …`、`<path> is not a directory. …`、`<entry> is not a regular file. …`、`That directory holds no SKILL.md at its root, and a skill has exactly one. Files found: …`、`SKILL.md cannot be loaded as a skill: <code> (line <n>): <message>. …`、`The skill holds more than <n> files. …`、`<file> is larger than <n> bytes. …`、`The skill is larger than <n> bytes. …`、`This session has no account, so nothing can be filed in a skill library. …`、`The skill library answered HTTP <status>: <body>. Nothing was published.`、`The skill library refused the publication: <platform message>. Nothing was published — fix that and publish again.`，以及 `The skill library could not be reached: <reason>. Nothing was published — this deployment installs skills only through its platform, so this call did not land.`

#### Token 影响

每次调用一条短结果，与技能大小无关：文件从会话工作区读，从不渲染进对话。失败的调用只多出它那一行错误。

#### KV Cache 影响

只追加；新出现的可见内容跟在可复用的请求前缀之后，不会让已有的 KV-cache 条目失效。

## 已知限制与后续工作

- **没有平台就没有发布** — 插件没配目标就拒绝装载，所以连不上管理平台的部署根本发不出去。这是有意换来的：平台不列出的技能，它的用户用不上。
- **安装是平台做的，所以它的失败以拒收的形式到达** — 宿主会拒绝的名字（`name` 不是小写 kebab-case、`description` 为空）先在本地被拦下，但平台自己的安装器拒绝的任何东西，都按平台的原话报回来。
- **回滚的记录可能把归档留在存储里** — 平台的事务覆盖记录行和安装，不覆盖它已经写下去的那个对象。
- **符号链接条目一律拒绝** — 遍历只发布普通文件，所以链接共享材料的技能得先把材料拷进来。
- **没有 dry run** — 上限与文档校验都落在真实目录上；超大的树是在读完文件之后才被拒绝的。
