# Agent Note: 用一张文件面覆盖一个主体工作所及的五层目录

Status: implemented

[English](2026-10-21-five-scope-file-surface.md) | 中文

> 业务模块要展示、打开、编辑 harness 产出的文件，就得为它在 harness 里长一个 API 方法；而那些方法摸到的目录，用一个词同时称呼案件层与案件工作目录，还把每个会话目录放在该主体的工作目录里面。

## Problem

harness 之上的业务层会产出并编辑 agent 也在处理的文档：技能写出的报告、案件成员上传的合同模板、案件的共享输入。每来一个这样的模块就带来一个 harness 方法——读这个产物的字节、把那个模板写回去——于是 harness 按业务对象长端点，业务层则知道了 harness 把目录放在哪（一条 Ceph 路径、一个挂载点、一个会话目录名）。两边都是错的主人：目录该由 harness 决定，业务模块不该需要比「文件地址」更多的东西。

宿主机上的布局让这个地址根本说不出来。`<workspaceRoot>/shared/` 同时装着案件的工作目录和案件的 `config`/`skills`/`tools` 三层，于是一个名字指两样东西。每个会话目录又都在该主体的工作目录里，所以一旦把那个工作目录露出来——案件成员显然只该拥有这一层——就等于把这个成员的所有会话一起露出来。

## Decision

五层作用域，各一个宿主目录、各一个沙箱挂载点，一张 HTTP 面覆盖全部五层：

| 作用域 | 宿主目录 | 沙箱 | 可写 |
|---|---|---|---|
| `session` | `<workspaceRoot>/users/<subject>/sessions/<sessionId>` | `/sessions/<sessionId>` | 是 |
| `user` | `<workspaceRoot>/users/<subject>/work` | `/workspace` | 是 |
| `case` | `<workspaceRoot>/work` | `/case` | 否 |
| `global` | `<usersRoot>/<subject>/work` | `/global` | 否 |
| `system` | `<systemRoot>` | `<systemRoot>`（同路径） | 否 |

- 工作目录叫 `work/`，并且都是叶子：工作目录永远不是某一层目录的祖先、也不是另一个主体的祖先，因此挂载它就是只露出文件。
- 案件三层目录是 `<workspaceRoot>/{config,skills,tools}`，与 `work/` 平级。案件工作目录的沙箱挂载点是 `/case`，只读开关叫 `caseReadOnly`；两个名字现在都说明了它指的是哪个目录。
- 会话目录放在自己的 `<workspaceRoot>/users/<subject>/sessions/<sessionId>` 下，挂到 `/sessions`，会话的工作目录是 `/sessions/<sessionId>`。主体的工作目录与他的会话目录是两个挂载，谁都不会把另一个扩大。
- `@deepseek-ai/dsh-tenant-fs-http` 在 `/<prefix>/<scope>/<path>` 上提供 `GET`、`HEAD`、`PUT`，并在 `/<prefix>/<scope>?path=<dir>` 提供目录清单。它不自持状态：文件系统就是记录，因此模型下一轮读同一个路径，看到的正是业务侧刚写进去的字节。
- 每个版本都带 ETag，由大小与纳秒级修改时间导出。`If-Match` 把写入变成有条件的（并发写入者拿到 `412` 并重读），`If-None-Match` 答 `304`，写入先落同目录临时文件再改名就位。
- 三个只读作用域对写入答 `403`，而不是悄悄失败：案件与全局工作目录由业务侧写入，系统树由运维写入。上表的可写列说的是本面接受什么；沙箱能不能写 `/case` 与 `/global` 是 `caseReadOnly`/`usersReadOnly` 的另一项决定。
- 路径解析做两层围栏。是 `.`、`..`、空段或含分隔符的段，在碰到文件系统之前就被拒；作用域根与目标最近的已存在祖先都过一遍 `realpath`，所以在可写作用域里种符号链接也换不到外面。
- `session` 路径把会话 id 写在第一段，且本面拒绝写入不存在的会话目录：会话由会话生命周期创建，不由一次文件写入创建。
- 这条路由由 `tenant-app` 作为静态行挂载，并被启动核对探到，因此丢了这一块的部署会立刻报错，而不是在业务层依赖的面上答 `404`。
- 这条路由应答所用的 `node:http` ↔ fetch 适配器在 `@deepseek-ai/dsh-host-webserver` 里只有一份实现（`bridgeFetchRequest`），因此几个会用 HTTP 服务的载体——本面、租户 `/api` 载体、浏览器连接的宿主半——共用同一个正文上限、同一条背压路径与同一次客户端断开中止，而不是各自存一份。

## Alternatives considered

- **给每个业务对象留一个 harness 方法。** 否：这正是要去掉的耦合。新模块得先在 harness 里加一个方法、一个 DTO、一个测试，才能显示一个文件；harness 也会一直知道报告表与模板行。
- **在租户容器里操作，而不是在宿主目录上。** 否：那让读一个文件取决于沙箱在跑，停掉的沙箱会让一份持久文件消失，还把业务请求放到容器的请求路径上。宿主通过同一个挂载源已经看得见同一批字节。
- **只露出可写作用域。** 否：案件层与系统树恰恰是报告与模板要读的东西。只读访问加上对写入的明确拒绝，是更小的面。
- **用内容摘要导出 ETag。** 否：它回答同一个问题，代价是每次 `GET` 把文件读两遍。大小与纳秒级修改时间在每次写入时都会变，而前置条件要的正是这个性质。
- **让本面按需建会话目录。** 否：一次文件写入会造出一个会话，而会话自己的生命周期随后会看到一个不是它建的目录。
- **只服务工作目录，其余由各模块自带路由。** 否：五个作用域共用一个前缀，才是业务侧得以通用的原因。新模块不加路由。
- **让文件字节走 `ctx.fs`。** 不可能：那条缝写文本，而报告是二进制文档。本面在自带围栏之后用 `node:fs`，这也是围栏写在上文、而不是继承来的原因。

## Consequences

- 业务模块现在存的是作用域加相对路径，而不是宿主路径：`user/reports/2026-10.md`，不是某个 Ceph 位置。harness 之上再没有谁需要知道挂载点或租户根。
- 这反转了 [Give every session its own work directory on the mounted case workspace](2026-10-14-sandbox-session-work-directory.md) 记录的位置：会话目录是独立挂载下的 `/sessions/<sessionId>`，而那份 note 否掉的「会话目录放在平台自有的名字下」正是现在发布的方案。那份 note 拒绝把会话目录放进 `/workspace` 的判断仍然成立，变的只是它指认的挂载点。
- 本 note 的布局部分修正 [One `.dsh` root and one directory list for a tenant](2026-10-13-single-tenant-root-and-directory-list.md) 里的目录名：它原先列 `shared/` 与每个会话目录，现在列 `work/` 与 `sessions/`。
- 部署要迁移两处：把 `sandbox.sharedReadOnly` 改名成 `sandbox.caseReadOnly`；把 `shared/{config,skills,tools}` 上提一层、`shared/` 改成 `work/`、`users/<subject>/<sessionId>` 改成 `users/<subject>/sessions/<sessionId>`。
- 发布侧读的是同一张表：`object_publish` 把 `/workspace`、`/sessions`、`/case`、`/global` 映射到本布局给出的工作目录与会话目录，因此模型写在自己会话目录里的文件不必先搬走就能发布，相对路径也按那个会话目录解析。
- 并发是有条件的，不是独占的：两个客户端可以都读到同一个版本、都写。后写的那个以 `412` 落败并必须重读，所以忽略 `412` 的客户端会丢掉一次编辑。harness 不做任何串行化，去保护一个模型也同时在写的文件。
- 字节传输受 `maxBytes`（默认 64 MiB）限制，它同时约束一次写入与桥接缓冲的请求体。比这更大的报告目前没有走本面的上传通道。
- 没有审计、没有按主体的配额、也没有删除：业务侧不再想要的文件会一直留着，直到有宿主访问权的人把它删掉。
- 业务客户端现在可以在模型回合进行中改动一个文件，而模型下一次读就会看到改动。这正是目的；这也意味着一个回合对某个文件的既有假设可能在同一个回合内失效。
- Cross-links: 本 note 的布局部分是 [One `.dsh` root and one directory list for a tenant](2026-10-13-single-tenant-root-and-directory-list.md) 的目录清单，本面是 [Multi-tenant slice](2026-08-24-multi-tenant-slice.md) 那份组合里的一行，而它反转的会话位置是 [Give every session its own work directory on the mounted case workspace](2026-10-14-sandbox-session-work-directory.md)。

### Verification

- `packages/tenant/fs-http/tests/roots.spec.ts` 钉住作用域表与两层围栏：未知作用域、未配置的作用域答 `503`、根不存在、每一种不安全段、解不出来的转义、以及解析到根外的符号链接。
- `packages/tenant/fs-http/tests/fs-http.spec.ts` 从每一层读一个文件、回答 `HEAD` 与 `304`、写一个下一次读得到的文件、用 `412` 拒绝过期 `If-Match` 且把赢家的字节留在原地、拒绝写入三个只读作用域、列目录并给每个文件带 ETag、拒绝不存在的会话目录、对错误的条目种类答 `409`、把穿越尝试留在根内、回答 `405` 与 `413`、在缺少租户作用域凭据与非成员时失败关闭，并在真实 `webServer` 上回环同一张面。
- `packages/host/webserver/tests/fetch-bridge.spec.ts` 钉住这个共用适配器：分发前按声明长度答 `413`、正文流式越过上限答 `413`、连正文一起复制头部、空正文、流式正文在 `drain` 之后才继续、正常结束后不中止，以及客户端断开时 handler 观察到的中止。
- `packages/tenant/object-store/tests/object-publish.spec.ts` 从 `/workspace`、`/sessions`、`/case`、`/global` 各自发布一次，并钉住相对路径按会话自己的目录解析。
- `packages/tenant` 下 508 个测试通过（37 个文件，含上面 24 个），`pnpm run typecheck` 干净。