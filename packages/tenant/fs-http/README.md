# @deepseek-ai/dsh-tenant-fs-http

多租户文件面（`ctx.tenantFsHttp`）：把当前 (租户, 用户) 的五个宿主目录合成一个字节通道。上层业务按「作用域 + 路径」读写服务器上的真实文件，不必知道 DSH 把它们放在哪个目录、更不必变成沙箱里的进程；模型下一轮读同一个路径时看到的正是业务侧刚写进去的那份字节。

它注入 `tenantAuth` 与 `tenants`：每个请求先认证凭据、再按成员身份解析出 (租户, 用户)，然后才解析路径。存在 `webServer` 时它注册一条 `prefix` 路由（默认 `/files`）；不存在时（headless、测试）仍然以 `fetch` 形式为进程内调用者服务。

## 路径与作用域

| 作用域 | 宿主目录 | 沙箱 | 可写 |
|---|---|---|---|
| `session` | `<workspaceRoot>/users/<subject>/sessions/<sessionId>` | `/sessions/<sessionId>` | 是 |
| `user` | `<workspaceRoot>/users/<subject>/work` | `/workspace` | 是 |
| `case` | `<workspaceRoot>/work` | `/case` | 否 |
| `global` | `<usersRoot>/<subject>/work` | `/global` | 否 |
| `system` | `<systemRoot>` | `<systemRoot>`（同路径） | 否 |

请求形状是 `GET|HEAD|PUT /files/<scope>/<path>`，会话作用域把会话 id 写成第一段：`/files/session/<sessionId>/notes.md`。三个只读作用域是部署的读侧——案件与全局工作目录由业务侧写入、系统树由运维写入——所以任何写都答 `403 file-readonly`，而不是静默失败。表的可写列说的是**业务侧经本面**能不能写；沙箱侧能不能写 `/case` 与 `/global` 由 `caseReadOnly`/`usersReadOnly` 决定，是另一件事。

`GET /files/<scope>?path=<dir>` 列目录，返回 `{ scope, path, writable, entries }`：每个文件条目带 `size`、`modifiedAt` 与它的 `etag`，因此前端点开一个文件就能直接读、改、带 `If-Match` 写回，不需要先发一次 `HEAD`。写入过程中的临时文件（`.<name>.dsh-tmp.<hex>`）不出现在清单里。

路径段按 URL 编码送：中文与空格写成 `%XX`（`/files/user/案子报告%EF%BC%882026%EF%BC%89.docx`），服务端逐段解码后在校验段名之前不接受原始非 ASCII 字节。字面文件名不做任何改写（不转拼音、不去括号），所以宿主目录里看到的正是业务侧调用时用的那个名字。

## 方法

| 方法 | 语义 | 成功应答 |
|---|---|---|
| `GET` | 读一个文件的字节，或列一个目录 | `200` + 字节（`etag`、`last-modified`、`content-type`、`content-length`）；`304` 且无正文当 `If-None-Match` 命中当前版本 |
| `HEAD` | 只取头部 | `200` + 同样的头部、无正文 |
| `PUT` | 写一个文件的字节 | `200` + `{ scope, path, size, etag }` |

写入先落到同目录的临时文件、再 `rename` 就位：读者看到的要么是旧版本、要么是新版本，不会是写了一半的文件；中断的写不会在清单里留下残留条目。

## 版本与并发

`ETag` 由文件的大小与纳秒级修改时间导出（`"<size>-<mtimeNs>"` 的十六进制），任何一次写都会改变它——临时文件改名就位也会改变修改时间。

- **`If-Match`** 是写入的前置条件：与当前版本一致才写；不一致答 `412 file-conflict`，且磁盘上的字节不动。`If-Match: *` 表示「这个文件必须已经存在」。
- **`If-None-Match`** 命中当前版本时 `GET` 答 `304`。

这样一轮编辑就是「读 → 改 → 带 `If-Match` 写回」：两个人同时改同一个文件时，后写的那个拿到 `412` 并重读，而不是悄悄覆盖。ETag 不存在任何表里——文件本身是唯一记录，所以模型那一侧下一次读到的就是这次写入。

用内容摘要也能得到同样的语义，代价是每次 `GET` 都要把文件多读一遍；文件大小与修改时间在「任何一次写都改变它」这一点上与内容摘要等价。

## 授权与围栏

凭据必须是租户作用域的：平台凭据证明不了任何租户，而每个作用域都挂在一条租户记录与一个主体上，所以它答 `401`。认证之后 `ctx.tenants.resolveMember` 校验成员身份，未获准入的主体答 `403`。

每次路径解析都做两层校验：

1. **段名**：空段、`.`、`..`、含路径分隔符或 NUL 的段在碰到文件系统之前就被拒（`400 file-path-invalid`）。百分号编码的斜杠解码后同样落入这一条。
2. **文件系统**：作用域根与目标最近的已存在祖先都过一遍 `realpath`，解析结果必须仍在根内。因此可写目录里种一个指向外部的符号链接也换不到作用域之外的文件——读和写都换不到。

作用域根不存在时答 `503 file-root-missing`，而不是 404：404 会把「部署没建这个目录」说成「这里本来就空」。

## 配置

```yaml
- id: tenant-fs-http
  name: '@deepseek-ai/dsh-tenant-fs-http'
  config:
    path: /files
    usersRoot: /opt/dsh/.dsh/users
    systemRoot: /opt/dsh/.dsh/system
    maxBytes: 67108864
```

`path` 默认 `/files`。`usersRoot` 与 `systemRoot` 只决定 `global` 与 `system` 两个作用域：不配就没有那个作用域，请求答 `503 file-scope-unavailable`（`session`、`user`、`case` 三个作用域由租户记录的 `workspaceRoot` 决定，无需配置）。`maxBytes` 默认 64 MiB，同时是 `PUT` 正文与容器内桥接缓冲的上限：这份面面向报告与文档，不是磁盘镜像通道。

## Model Experience

None, as the file surface moves bytes between an authenticated caller and the host directories a subject works in; the model reads and writes those same files through its own file tools, so this carrier registers no token, tool, or prompt content.

#### KV Cache effect

无；本包既不组装也不发送供应商请求。

## Known Limitations and Deferred Work

- **没有 `DELETE`，也没有 `Range`。** 范围请求与大文件断点续传尚未提供，读一份超过 `maxBytes` 的文件仍然可以（限制只作用于写），但只能整份取。
- **`PUT` 会在可写作用域里建父目录。** 写 `user/a/b/c.md` 会建出 `a/b`；会话作用域反而更严——会话目录必须已由会话启动创建，否则答 `404 file-session-unknown`，因为写一个文件不该顺带造出一个会话。
- **ETag 不是内容摘要。** 它按大小与纳秒级修改时间导出；文件系统不提供纳秒修改时间时（例如某些 FAT 挂载）精度下降，同一时间窗内的两次写可能得到同一个 ETag。要绝对的内容寻址需要每次读取多算一遍摘要。
- **没有审计与配额。** 每次读写只进宿主日志；谁在什么时候改了哪个文件、一个主体能占多少空间，都不在本面记录。
- **`system` 作用域是整个系统树。** 只读，但可读：它包含 `skills/` 与配置，暴露给业务侧是否合适取决于部署；不需要时别配 `systemRoot`，那个作用域就不存在。
