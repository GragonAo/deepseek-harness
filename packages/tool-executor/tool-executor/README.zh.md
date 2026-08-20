# @deepseek-ai/dsh-tool-executor

[English](README.md) | 中文

**`ToolExecutor`**（`ctx.toolExecutor`）定义了一个执行世界「做什么」—— 带着已验证的参数运行一个工具执行体，并回报规范化无损 JSON 值 —— 而不说「怎么做」。它是 agent 层/执行层分流所经过的 seam：每个离开 agent 层的工具执行体都在此服务之后执行，因此部署方按每个世界挂载一个提供方（`in-process`、强隔离的 `container`、…），无需改动工具注册表。

本包承担能力 seam 的服务定义角色（[capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md) 与 [agent/执行层提案](../../../.agents/notes/proposed/architecture/2026-08-20-agent-execution-plane.zh.md)）：提供方子类化 `ToolExecutor` 并注册服务；消费方是工具注册表（`dsh-tools`）。执行器对工具、会话或策略一无所知：它拿到一个执行体标识、已验证参数和一个中止信号，返回一个值或失败。

## 服务 API（`ctx.toolExecutor`）

| 成员 | 语义 |
|---|---|
| `execute(request)` | 用 `request.arguments` 运行 `request.toolId` 标识的一个执行体。对每次执行失败都以 `failure` 字段结案（`ToolExecutionFailure`：`exception`、`abort`、`invalid-output`、`execution-substrate`）；仅在调用方误用服务定义契约（例如处置后再提交请求）时才拒绝。 |
| `isolation` | 只读描述符：执行基质（`'in-process'`、`'process'`、`'container'`）。供部署与诊断使用的标签，**非安全声明**。 |

每个实现必须遵守的语义（契约细节见类 JSDoc）：参数与返回值都是完整无损 JSON；执行体只见其中止信号 —— 无 agent、会话、审批或注册表上下文 —— 因此执行体运行无法触及 agent 层状态；处置会中止在途执行，并在完成前等待其退出。

## 词表

`ToolExecutionRequest`（`toolId`、`arguments`、`signal`、`body?`）承载执行所依据的一切 —— 默认值（时间预算、输出上限）是提供方校验过的配置，绝不藏在 `execute()` 内的 `??` 里。`arguments` 与返回的 `value` 都是 `ToolExecutionValue`，即会话规范化 `JsonValue` 的服务本地结构等价，使本服务定义独立于会话（`CodeJsonValue` 先例在 `dsh-code-runtime`）。`ToolBodyId` 是 agent 层在注册时铸造、执行世界据此定位执行体的品牌化不透明标识。可选的 `body` 字段在执行世界就是本进程时内联携带执行体；未收到内联执行体的跨进程世界按 `toolId` 在自己的注册表中解析。`ToolExecutionOutcome` 回报无损 JSON `value?` 与 `failure?`（`ToolExecutionFailure`：`kind` + 可回馈模型的 `message`）。`ToolBody` / `ToolBodyContext` 定义跨层执行体签名：参数进、值出、仅一个取消信号。完整契约见 `src/types.ts`。

## 模型体验

无，因为本抽象 seam 不注册任何模型可见上下文；挂载提供方后，任何呈现效果归工具注册表（消费方）所有。

#### KV 缓存效果

无直接失效；本包不贡献请求 token。

## 已知限制与延后工作

- **尚无提供方** —— `'in-process'`/`'process'`/`'container'` 声明为知名 `isolation` 值；`in-process` 提供方（验证后端）与 `container` 提供方（硬多租户边界）是独立包。
- **`execute()` 是一次性的** —— 结果只在结案的 `ToolExecutionOutcome` 上到达；流式或持久执行体在 seam 处无进度 API。
- **执行体只见一个信号** —— 需要 agent、会话或审批上下文的执行体无法在此 seam 之后运行；这类工具有意留在 agent 层。
