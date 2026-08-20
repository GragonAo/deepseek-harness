# 第 6 章 · 一次 turn 的完整旅程

> 阶段：深入源码。用一个具体场景把第 5 章的六个包串起来：用户发一条消息，模型提议跑一个 shell 命令，工具执行，循环结束。配套：时序图 [`docs/agent-lifecycle.md`](../docs/agent-lifecycle.md) 与 [`docs/architecture.md#turn-flow`](../docs/architecture.md#turn-flow)。

## 阶段 0：输入到达 inbox

用户 `User->>Agent: followup(content)`。消息带着标识（`MessageId`）与来源进入**唯一的 inbox**。`Inbox` 是 agent 拥有的持久投影，两条有序待处理列表：`next-turn` 与 `next-step`。`followup` 投 `next-turn` 并唤醒 driver；`inject` 投 `next-step` **不唤醒**；`steer` 投 steering。每次操作记录规范化的 `agent/inbox/*` 事件（`inserted`/`claimed`/`discarded`/`spliced`）。

## 阶段 1：认领与轮次开启

driver 被唤醒 → 发 `agent/status: running` → 写 `turn/start`。认领「全部 `next-step` 输入 + 轮次边界上的一条 `next-turn` 消息」，逐条发 `agent/inbox/claimed`。

## 阶段 2：`agent/pre-step` 决策门

`agent/pre-step` waterfall 收到独占的已认领批次（`messages`）、拟进入步骤的坐标（`turn`、`step`）、当前轮次取消 `signal`。返回 `PreStepDecision`：

- `{ kind: 'reject' }`：不打开 step；认领的消息「到此为止」——不 discard、也不再作为 user/message 重发，轮次关闭且不消耗 step。
- `{ kind: 'enter', messages }`：提供在 `step/start` 后追加的完整消息批次。

监听器可改写消息或拒绝；`compaction-basic` 在这里处理压力（context overflow），`agent-instructions`/`time-context` 等在这里注入/改写上下文。

## 阶段 3：打开 step、入日志

`enter` 后写 `step/start`，把进入的消息逐条写为 `user/message`（带 `surfaceOp: 'append'`）。

## 阶段 4：组装请求

`buildRequest()` = `systemPrompt.assemble()`（合并 scope 链片段 + `system-prompt/assemble` waterfall）+ `session.deriveMessages()`（从日志投影 `Message[]`）+ 组装工具 schema。请求信封作为 `request/header` 快照写入日志：`seedConfig` 经 `agent/request` waterfall → `llm.prepareCall` → `canonicalHeader` 与基线 `headerEquals` 比较，**变化时**才写新快照（reason `initial|resume|change`），保证每个对话请求都是日志的纯函数（`foldRequestHeader` 取最新快照重建）。

## 阶段 5：发起模型请求

`agent/request` waterfall → `llm/stream` waterfall → 流式返回 `StreamChunk*`。每个 chunk 写入 `assistant/chunk`（token 级回放保真）；成功后写 `assistant/message`（派生历史用它，带 `usage` 与 `sourceEventSeqs`）。失败则走 `agent/request-error` waterfall，监听器可返回 `{ kind: 'retry' }` 拥有恢复权，否则失败定型。

## 阶段 6：工具批次执行

模型消息里出现 tool-call 块 → 写 `tool/call`（`name` + 未解析 `arguments` + `callId`）→ `executeToolCalls`：按 `exclusive`（单独成 barrier）/ `parallel` 分组，用上限 `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10` 的有界滚动池**并行执行、按模型顺序提交**（`commitReady` 按模型顺序 `finalize` 后写结果）。每个调用走第 7 章流水线，产出写 `tool/result`（`sourceEventSeqs: [callSeq]`）。中途取消时，未启动的调用 append 合成 `ABORTED_BEFORE_DISPATCH` 结果以保 replay 有效。若有 `additionalContexts`，在已记录的工具结果后注入 `user/message`。

## 阶段 7：收尾

- 若「自然停止且 next-step inbox 为空」→ `agent/turn-stopping`（serial，无 `next()`，终端检查点）。
- 若 next-step 有输入 → 认领 → 再次进入 `agent/pre-step`（下一步骤）。
- 一切结算后写 `turn/end`（带 `TurnEndReason`：`completed`/`aborted`/`blocked`/`error`/`max-tokens`/`interrupted`）→ 发 `agent/status: idle`。

## 关键接线点速查

| 事件 | 模式 | 语义 | 谁消费（举例） |
|---|---|---|---|
| `agent/pre-step` | waterfall | 改写/拒绝进入步骤的消息 | compaction、agent-instructions、hooks |
| `agent/request` | waterfall | 替换冻结的调用配置（不可改消息） | agent 自己 |
| `agent/request-error` | waterfall | 拥有恢复权则 `retry` | compaction-basic、llm-retry |
| `system-prompt/assemble` | waterfall | 改写提示词前缀 | agent、agent-presets |
| `llm/stream` | waterfall | 流式产出 | agent-loop、llm-replay |
| `agent/turn-stopping` | serial | 终端检查点 | hooks |

## 记牢两点

1. **轮次/步骤边界是持久会话事件**（`turn/*`、`step/*`），**不是** agent emit；`agent/*` 是实时协调接口。
2. **SDK/UI 要回放 transcript 就消费 `session/event`**；`agent/*` 用于队列/状态/拦截/构造请求/steering/续行/错误处理。

下一章把阶段 6 的工具调用拆到流水线级别。