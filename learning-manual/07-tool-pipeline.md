# 第 7 章 · 工具执行流水线

> 阶段：深入源码。一次 `tool/call` 从模型请求到 `tool/result` 落库，中途发生了什么。参考：[`docs/tool-execution-pipeline.md`](../docs/tool-execution-pipeline.md)、[`docs/subsystems/tools.md`](../docs/subsystems/tools.md)。

## 全景

策略、钩子、沙箱、文件系统守卫、结果重写、最终观察、UI 渲染都在这里发生，而**不改变循环**。核心是三个 waterfall + 守卫 + 规范化 + 最终回调：

```text
tools/pre-execute (waterfall：hooks、permission、sandbox 裁决)
  → 单调守卫（deny 或弃权；身份受保护）
  → tools/execute  (waterfall：timeout、retry、metrics 环绕分发)
      → 工具注册的 execute() 体
      → fs/write-intent | fs/edit-intent（仅 tool-fs 的写/改）
  → tools/post-execute (waterfall：accept、block、replace、add context)
  → 注册表外层规范化（pipeline/result 快照抛错 → isError）
  → ToolDefinition.finalizeContent（最后的、仅内容、同步不变式）
  → tools/result（同步通知，冻结的权威结果）
```

## 三个核心决策/守卫类型

- `PreToolDecision` = `{kind:'allow'}` | `{kind:'deny'; reason}` | `{kind:'ask'; reason?}`——pre-execute 的返回值。
- `PostToolDecision` = `{kind:'accept'}`（可带 `content` 或 `value` 之一）| `{kind:'block'; feedback}`——post-execute 的返回值。
- `ToolGuard = (execution) => string | undefined`——单调守卫：deny 或弃权，**无 allow**（身份受保护）。

## 逐段拆解

### 1. 记录 `tool/call`（执行前）

模型消息里的 tool-call 块先落库 `tool/call`（`name` + 未解析的 `arguments` JSON 字符串 + `callId`）。`callId` 关联调用与结果。

### 2. `tools/pre-execute` waterfall

hooks、权限、沙箱在这里裁决。可返回 `allow` / `deny` / `ask`：

- `deny` → 跳过工具体，进入 post-execute。
- `ask` → 转 `ctx.approval` 一次性审批（`approval/request` waterfall；没有/不可回答的 answerer 则 fail-closed 为 `unavailable` 拒）。
- `allow` → 继续到守卫。

### 3. 单调守卫

注册的单调守卫只能 `deny` 或弃权（身份受保护）。不得重排的所有者政策作为已注册守卫。被拒与「审批被拒」都会 produce 一个**有约束力的驳回结果**（对 Code Mode 子调用）或跳过工具体。

### 4. `tools/execute` waterfall + 工具体

`tools/execute` 是**环绕分发**（around-dispatch）：`@deepseek-ai/dsh-tool-call-timeout-policy`（`packages/guard/timeout-policy`，独立于 `core/tools`）把它包装成 `deadline(exec.signal, timeoutMs, 'TOOL_TIMEOUT')` 的协作 deadline（超时替换为结构化 `TOOL_TIMEOUT` 结果——**协作而非硬杀**，终止权在工具转发 `exec.signal` 的能力）。`timeoutMs` 是协作超时预算元数据，**从不发给模型**（schema 白名单只保留 `name`/`description`/`parameters`）。retry、metrics 也在此环绕。注册表在每个 wrapper 之后用 `fuseToolSignals` 重新融合调用方原始 signal，所以包装层无法切断调用方取消。工具体是注册的 `ToolDefinition.execute()`。

### 5. 文件系统写意图门

仅 `tool-fs`/`tool-str-replace-editor` 的写/改，在工具体下对流经 `fs/write-intent` / `fs/edit-intent` waterfall；`fs-observation-policy` 在此做「先读后编辑」等政策门禁。

### 6. `tools/post-execute` waterfall

可 `accept` / `block` / `replace` / `add context`。guard 的 `repeat-tool-reminder` 通过 decision 的 `additionalContexts` 注入提醒（source `{kind:'plugin', plugin:'repeat-tool-reminder'}`），**绝不覆盖** `content`/`tool/result`；guard 永远 `next()` 委托。

### 7. 规范化 → `finalizeContent` → `tools/result`

注册表在 `createExecution` 阶段对候选做**无损快照**（分配 `token`、冻结 args、登记 `deferredContexts`/`finalizeContent`/`cancellationStates`），快照失败则先规范化为失败（`isError`）。之后由定义里「随快照固定的」`finalizeContent` 回调执行同步、仅内容的不变式（恰好一次）。最后 `tools/result`（同步通知）观察**不可变、可 JSON 无损表示**的结果。错误统一归一化为结构化 `isError`：未知工具 → `UNKNOWN_TOOL`；取消 → 工具体已调用 `ABORTED`、未调用 `ABORTED_BEFORE_DISPATCH`。

## 设计意图

流水线把「跨工具系列的政策」与「工具自身逻辑」解耦：hooks 可以横跨所有工具，而无需让任何工具耦合到某个政策服务。三个 waterfall 都能改写一次调用；由定义控制的 `finalizeContent` 与其后的 `tools/result` 在此之后运行。

## Code Mode 的特殊性

Code Mode 把保留的 `run_code` 传输及其序列化子调用**都送入同一流水线**：子调用携带父 token、记录 `tool/code-dispatch`、把拒绝呈现为有约束力的驳回，并**省略 `additionalContexts`**（保持调用与结果相邻）。`tools/view()` 做 restriction 交集 + 本作用域豁免 + `run_code` 折叠。

## 一个工具从注册到执行的完整链路

1. 插件用 `defineTool` DSL 在 `ctx.tools` 注册 `ToolDefinition`（schema + execute + 可选 finalizeContent + UI 回调）。
2. 它的 schema 经 `ctx.systemPrompt.tools(provider)` 进入每次请求的前缀组装。
3. 模型请求 → `tool/call` → 上面流水线 → `tool/result` → 模型下一步从日志派生历史时看到 `tool-result` 块。

「加一个工具」的完整实操见第 14 章与 [`docs/cookbook/adding-a-tool.md`](../docs/cookbook/adding-a-tool.md)。