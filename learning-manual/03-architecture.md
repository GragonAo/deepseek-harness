# 第 3 章 · 架构全景

> 阶段：会用 → 理解。本章是改 `packages/` 之前的准入门槛，对应 [`docs/architecture.md`](../docs/architecture.md)。

## 组合：profile 与 bundle

一个运行中的 `dsh` 是一棵**在启动时从有序层（layer）拼出来的插件树**（[`docs/architecture.md`](../docs/architecture.md#profiles-and-bundles)）：

- **profile**：存储在 Harness home 的具名组合，列出了它叠加的 bundle、它安装的树外插件，以及用户自己的 `cordis.patch.yml`。`web` 与 `headless` 是内置模板。
- **bundle**：Cordis 配置行 + 它们挂载的代码的**分发格式**，保证它插入的内容仍能被上层 patch。

每个都在自己的 `package.json` 的 `dsh` 字段里自报身份：`dsh.profile` 列出 profile 的 bundles，`dsh.bundle` 指向 bundle 的 patch 文件。

层级对一个空 entry 列表按顺序生效：profile 列出的每个 bundle → profile 的 `cordis.patch.yml` → home 级 patch → 任意 `--patch` overlay。patch 按 id 定位一行并整段替换它的 config，或插入新行。

想看你机器实际启动的树：

```sh
dsh --profile web --dump-config
```

它打印的**任意一行都可以被你的 patch 替换**。这是 dsh「无特权核心」的直接体现：组合本身就是数据。

## 六个核心包

主干是六个包，每个组合都会启动它们（[`docs/architecture.md`](../docs/architecture.md#core-packages)）：

| 包 | 负责 | `ctx` key |
|---|---|---|
| [`core/session`](../packages/core/session/README.md) | 仅追加的 `SessionEvent` 日志与内存 store | `ctx.sessions` |
| [`core/system-prompt`](../packages/core/system-prompt/README.md) | 提示词段落与工具 schema 组装 | `ctx.systemPrompt` |
| [`core/tools`](../packages/core/tools/README.md) | 带作用域的工具注册表 + 守卫执行流水线 | `ctx.tools` |
| [`core/agent`](../packages/core/agent/README.md) | `Agent` 接口、实时注册表、`agent/*` 事件 | `ctx.agents` |
| [`core/agent-loop`](../packages/core/agent-loop/README.md) | 实现该接口的默认 driver | `ctx.agentLoop` |
| [`core/scope`](../packages/core/scope/README.md) | 按 agent 的作用域注册原语 | 库，无 key |

第 5 章逐包精读源码。

## 三层事件

事件是扩展点，选对事件域是大多数改动的第一步（[`docs/architecture.md`](../docs/architecture.md#events)）：

- **会话事件**：追加到日志的持久事实，经 `session/event` 广播。需要跨 reload 存活的事实用它。
- **Agent 事件**（`agent/*`）：携带活的 `Agent`——inbox、step、status、request、validation、continuation。观察/拦截在途工作用它。
- **能力事件**（`fs/*`、`tools/*`、`telemetry/*`）：给一个 seam 挂政策与适配器，不导入循环。

完整事件生产方/消费方矩阵见 [`docs/event-producer-consumer.md`](../docs/event-producer-consumer.md)（本仓库用 TypeScript Program 解析生成）。第 8 章讲事件机制本身。

## 轮次 / 步骤流

一个 **step** = 一次模型请求 + 它调用的工具。一个 **turn** = 零到多个 step：在第一个输入被认领前打开，在「什么都不再欠着」时关闭（[`docs/architecture.md`](../docs/architecture.md#turn-flow)）：

```text
turn/start
  认领 next-step 输入 + 一条排队消息
  组装提示词段落 + 工具 schema
  → agent/pre-step          reject | enter(messages)
     reject，或首次 enter 被改写为空 → 关闭轮次且不消耗 step
     step/start
     把进入的消息追加为 user/message
     从日志派生模型历史（deriveMessages）
     agent/request → llm/stream → assistant/chunk* → assistant/message
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
     工具还欠一次请求，或 next-step 输入到了 → 认领 → 下一步
  → agent/turn-stopping
turn/end
```

要点：

- `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是**持久会话事件**；其余是跨三个域的**实时扩展点**。
- `agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是 waterfall（监听器必须 `next()`）；`agent/turn-stopping` 是 serial（无 `next()`）。
- 输入经过**唯一一个 inbox** 到达 driver：有些消息立刻唤醒它，注入的上下文在 inbox 里等到另一条消息出现才动。
- `agent/pre-step` 决定模型看到什么：监听器可改写认领的消息或干脆 reject；被 reject 或首次被改写为空的 claim 仍会关闭一个不消耗 step 的持久轮次，从而日志记录了这次尝试。

时序图见 [`docs/agent-lifecycle.md`](../docs/agent-lifecycle.md)，工具流水线见 [`docs/tool-execution-pipeline.md`](../docs/tool-execution-pipeline.md)（第 7 章展开）。

## 会话日志是唯一真源

模型看到的上下文由 `deriveMessages()` 从日志**投影**；原始的 `assistant/chunk` 事件保证回放与 UI 保真。fork、resume、transcript、遥测、持久化全部从这条流派生（[`docs/architecture.md`](../docs/architecture.md#session-log)）。

**模型可见 ⟺ 已入日志**：凡进入模型请求的内容必须能从日志重建，且有一条运行时不变式断言之。这正是「新的模型可见输入需要新的会话事件」的原因：扩展 `SessionEventMap` 并从日志渲染。

## 能力 seam

一个 **seam** 是一个含三角色的可替换能力：**Service Definition**（声明接口）、**Service Provider**（实现之）、**Consumer**（使用之，通常是面向模型的工具）。一个包可以合三角色，但一个角色单独不是 seam；加一个能力意味着三者都要设计（[`docs/capability-seams.md`](../docs/capability-seams.md)）。

seam 是「换一个 provider 就换掉整个产品」的原因：文件系统与子进程 provider 共享**同一个执行世界**，把它们指向一个远程沙箱，Bash、PTY、LSP 会一起跟着走，而无需 fork 任何 provider。第 9、10 章专门展开。

## 新行为往哪挂

架构文档给了一张「目标 → 机制」表，改动了循环才更新它。节选最关键几行（全文见 [`docs/architecture.md`](../docs/architecture.md#where-new-behavior-goes)）：

| 目标 | 机制 |
|---|---|
| 加一个模型 provider | 在 `ctx.llm` 注册它的 adapter |
| 加一个面向模型的能力 | 在 `ctx.tools` 注册；schema 自动进入提示词组装 |
| 给某个会话换能力集 | 组合一个 agent preset；该服务行需 `isolate` realm |
| 拦截请求/工具/轮次 | 用对应 `agent/*` 或 `tools/*` 事件 |
| 加面向模型的上下文 | `agent.inject()`（落入下一次被接纳的请求） |
| 加持久会话状态 | 扩展 `SessionEventMap`，从日志渲染与回放 |
| 把注册限定给一个 agent | 用该 agent 的 `agent.ctx` |

## 小结

三句话记住本章：**dsh 是一棵按层拼出来的插件树**；**循环骨架 = session + systemPrompt + tools + agent + agentLoop + scope**；**一切扩展要么注册服务，要么监听事件，要么加会话事件**。下一章讲「为什么这么设计」。