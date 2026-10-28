# @deepseek-ai/dsh-tool-present

[English](README.md) | 中文

模型侧的 `present` 工具：一轮对话交给用户的文件清单。

## 它做什么

在 `ctx.tools` 上注册一个工具 `present(files: [{ path, description? }])`。每次调用向调用方 agent 会话的日志追加一条 `deliverables/presented` 事件——轮次、`callId` 与声明出来的文件。

这份声明是"这一轮交付了什么"的唯一来源。模型只是写过、草稿、抽取出来的中间数据、辅助脚本，只要没被 present 就不在清单里，所以客户端渲染的是这一轮决定交出去的东西，而不是这一轮碰过的所有路径。

轮次取自日志自身的边界，在追加事件时就写在载荷里，因此一条声明不会被后面的轮次认领；不在轮次内调用会被拒绝。

## 校验

`execute` 用组合进来的文件系统（`ctx.get('fs')`）按会话工作目录解析每个 `path`，要求它指向一个已存在的普通文件；记录的路径是后端的 display path，也就是执行世界里的绝对路径。解析结果重复、路径为空、`description` 为空串，都会在追加事件之前被拒绝。没有文件系统的无头组合会按模型写的原样记录、不做校验——声明照样持久，只是未经核实。

稳定的失败文本：`Error: present: every entry needs a non-empty \`path\``、`Error: present: "<path>" does not exist — declare the files this task actually wrote`、`Error: present: "<path>" is a <type>, not a file`、`Error: present: "<path>" is declared twice`、`Error: present requires an owning agent session`、`Error: present must be called while a turn is running`。

## 配置

`retainTurns`（默认 `50`）限制投影体积：投影状态只保留最近 `retainTurns` 个有交付的轮次，长会话不会每次下发都带上无界的逐轮清单。会话日志保留全部声明，扫历史的读者仍能找到更早的轮次。

## 会话投影

组合里挂了 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)）时，本包在注入的子上下文里注册 `deliverables` 单元：`init` = `{ turns: [] }`，`apply` 把每条 `deliverables/presented` 折进整份状态（该轮条目按首次声明顺序并入新路径、轮次保持升序、尾部按 `retainTurns` 截断；其余事件返回同一个状态引用），`view` 为恒等，`stateVersion` = 1。键在 `src/types.ts` 里并入 `SessionProjectionMap`；载体在历史尾页与 `session/projection` 推送帧里给出该值。

## 渲染

规范返回值是 `{ turn, files }`。调用卡是通用卡，标题 `Present deliverables`，原始输入就是声明的文件；模型可见的结果逐行列出路径与说明。

## 导出形态

函数插件：导出 `name` / `inject` / `Config` / `apply`，没有默认导出（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型看到什么

生成的 [`present` schema](../../../docs/tool-catalog.md)，外加一段系统提示词：只声明成品交付物，绝不声明草稿、中间数据或辅助脚本。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定。插件生命周期或作用域限制的变化可能让这段 schema 的缓存复用失效。

### 工具调用历史与结果

#### 模型看到什么

每次调用在 assistant 工具调用参数里保留声明的路径与说明。成功结果返回轮次与被声明的文件，每个文件一行 `- <path> — <description>`。`deliverables/presented` 事件是持久化的界面与重放状态，不是第二条模型消息。

#### Token 影响

随一轮声明的文件数增长；结果把路径重复一遍。

#### KV Cache 影响

只追加；新可见内容排在可复用的请求前缀之后，不会让已有 KV 缓存失效。

## 已知限制与后续工作

- **只按声明识别** —— 没有任何环节把声明的文件与本轮的写操作对账；声明时刻的文件系统校验（存在、是普通文件）就是边界。声明一个本轮没写过的文件是可能的，按模型对交付物的说法处理。
- **没有客户端半边** —— 本包不注册浏览器入口；租户部署通过业务面提供投影，harness 的 web 客户端不渲染它。
- **保留窗口是部署选择** —— `retainTurns` 只截断投影状态，不对底层声明做压缩。
