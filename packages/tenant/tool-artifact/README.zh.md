# @deepseek-ai/dsh-tool-artifact

[English](README.md) | 中文

案件作用域的产物交付。在容器沙箱里干活的模型把报告、HTML 摘要、图表和数据导出写在只有沙箱看得见的地方，而通过 Web 前端访问该部署的用户永远拿不到它们。本插件用两个面向模型的工具补上这一环：`artifact_publish` 把生成的文件复制进案件的静态目录（也就是前端所服务的那个目录），返回同源路径以及模型追加到回复里的交付标签；`artifact_list` 报告该主体已经交付过什么。

## 配置

```yaml
- name: '@deepseek-ai/dsh-tool-artifact'
  config:
    mediaRoot: /srv/cases-static          # host directory the front end serves
    urlPrefix: /media                     # same-origin route the front end serves it under
    publicOrigin: https://cases.example.cn         # optional; front-end origin, for the absolute `url` only
    usersRoot: /var/lib/dsh/users         # host root mounted at /global; omit when absent
    groupByKind: true                     # file into <kind>/ subdirectories
    maxBytes: 104857600                   # largest publishable file
```

`mediaRoot` 必须是该部署的 Web 前端实际服务的目录，`urlPrefix` 是它服务该目录所用的路由。两者不匹配时发布会成功、却产生死链，所以要用一次真实发布加一次对返回路径的抓取来核对。`publicOrigin` 只是一个源（origin）——绝对 `url` 是 `publicOrigin` + `public_path`，把路由写进去会让前缀重复一次。

## 工具

| 工具 | 参数 | 结果 |
|---|---|---|
| `artifact_publish` | `file_path`（必填，绝对路径或相对工作目录）、`title`、`kind`、`move` | `name`、`kind`、`public_path`、`url`（设置了 `publicOrigin` 时）、`attachment_tag`、`bytes`、`source_path`、`moved` |
| `artifact_list` | `limit`（默认 50，最大 200） | `entries`（`name`、`kind`、`public_path`、`bytes`、`modified`，最新在前）、`total` |

```
<mediaRoot>/<case>/<subject>/<kind>/<YYYYmmdd_HHMMSS>_<title>.<ext>
```

`kind` 由扩展名推断——`html`、`docs`、`sheets`、`slides`、`images`、`data`、`packages`、`other`——`groupByKind: false` 会去掉那层目录。发布默认是复制，源文件在沙箱里仍可读；`move: true` 在复制成功后删除它。

## 模型路径在哪里解析

本插件读取的是容器 provider 为调用主体绑定的同一批挂载，因此沙箱能写的路径恰好就是本工具能读的路径：

| 模型写入 | 本插件读取的宿主路径 | 交付到 |
|---|---|---|
| `/workspace/<rel>` | `<tenant.workspaceRoot>/users/<subject>/<rel>` | `<mediaRoot>/<case>/<subject>/…` |
| `/shared/<rel>` | `<tenant.workspaceRoot>/shared/<rel>` | `<mediaRoot>/<case>/<subject>/…` |
| `/global/<rel>` | `<usersRoot>/<subject>/<rel>` | `<mediaRoot>/<case>/<subject>/…` |

这些挂载之外的路径会被拒绝，解析出的文件在跟随符号链接之后还会被复查，因此挂载点内植入的链接读不到挂载之外。

## 隔离

发布被部署方所鉴权的两项请求权威限定两次：**案件**（`requireTenant()`）与**主体**（`requireUser()`）。一次调用只从调用主体的挂载读取、只写到 `<mediaRoot>/<case>/<subject>` 之下、只列出该目录。主体无法寻址另一个主体的工作区、无法发布另一个主体的文件，也无法枚举另一个主体的交付；另一个案件是另一个租户，因此是另一个目录。非案件作用域请求中的调用会明确失败，而不是回退到共享目录。

## 模型体验

### 交付一个生成的文件

#### 模型看到什么

`artifact_publish` 返回已交付文件的同源路径与交付标签，外加一条指令：把该标签原样作为独立段落追加到回复里。复制保留了源文件时，结果里还会给出源路径，模型于是能在后续轮次再次读取该文件。`artifact_list` 返回该主体的交付，最新在前。

#### Token 效应

两个工具 schema 常驻（合计约 250 token）。每次调用增加一条简短结果：已发布文件的路径、标签与大小，或列出的每条交付一行。

#### KV 缓存效应

仅追加；结果跟在可复用的请求前缀之后。

## 已知局限与后续工作

- **静态路由本身不带按主体的鉴权。** `urlPrefix` 由前端的静态处理器服务，因此任何知道已发布路径的客户端都能取到它。这里的隔离管的是模型能寻址和枚举什么；需要 URL 级强制的部署要在前端加，或在 `mediaRoot` 下放一段不可猜的路径段。
- **交付是先复制再记录，没有索引。** `artifact_list` 读目录，因此除文件名之外不保留每次交付的标题或来源。
- **路径里的案件与主体身份来自租户 id 与用户 id，并经过净化。** 若某部署的 id 只在净化会剔除的字符上有别，它们会撞进同一个目录。
- **每个案件一个物理目录。** 多副本部署必须共享 `mediaRoot`（共享卷或网络文件系统）；除排他创建文件之外，这里不协调两个副本写同一个带时间戳的名字。
