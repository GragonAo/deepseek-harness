# 第 14 章 · 扩展实战

> 阶段：精通。把前面所有机制落到「我要自己加一个 X」。每个目标给「机制 + 关键 API/文件 + 参考」。完整步骤见 [`docs/cookbook/extension-cookbook.md`](../docs/cookbook/extension-cookbook.md) 及各 how-to。

## 决策树：先问两个问题

1. 这是**一个新能力（可替换）**，还是**一个政策/拦截点**，还是**一段持久状态**？
2. 它的生命周期是**进程内实时**，还是**要跨 reload 存活**？

对应三个扩展面（第 4 章第 12 条）：新能力 → seam（服务）；拦截/政策 → 事件监听；持久模型可见状态 → 会话事件。

## 目标 → 机制速查

| 目标 | 机制（原文见 [`docs/architecture.md`](../docs/architecture.md#where-new-behavior-goes)） |
|---|---|
| 加模型 provider | 在 `ctx.llm` 注册 adapter |
| 加模型能力 | 在 `ctx.tools` 注册；schema 自动进提示词组装 |
| 给某会话换能力集 | 组合 agent preset；该服务行需 `isolate` realm |
| 加 shell 执行 | 注册 `ctx.shell` 后端；本地实现经 `ctx.subprocess` spawn |
| 加持久终端 | 注册 `ctx.terminals` 后端 + `dsh-tool-terminal` |
| 加人类命令 | 注册到 `ctx.commands`，不产生模型轮次 |
| 加后台工作 | 注册到 `ctx.jobs`；`job_*` 工具收/停 |
| 加文件系统/政策 | 注册 `ctx.fs` provider 或监听 `fs/*` 事件 |
| 限制子进程 | 用 `ctx.sandbox` 后端；consumer spawn 前包 argv |
| 拦截请求/工具/轮次 | 用 `agent/*` / `tools/*` 事件 |
| 加模型上下文 | `agent.inject()` |
| 加 UI/编辑器集成 | 驱动 `ctx.agents`、从 `session/event` 渲染 |
| 加 Web Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 加持久会话状态 | 扩展 `SessionEventMap`，从日志渲染与回放 |
| 生成标题 | 注册唯一 `ctx.sessionTitle` provider |
| 管理同会话目标 | 用 `ctx.goals`，经 `agent/*` 续跑 |
| fork 活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 作用域限定到某 agent | 用该 agent 的 `agent.ctx` |

## 五类最常见扩展

### 1. 加一个模型工具（最常见）

步骤（完整版 [`docs/cookbook/adding-a-tool.md`](../docs/cookbook/adding-a-tool.md)）：

1. 用 `defineTool` DSL 构造 `ToolDefinition`（`ToolSchema` + `execute` + 可选 `finalizeContent` + UI 回调）。
2. 在 `ctx.tools` 注册，disposer 从 `ctx.effect()` 返回。
3. schema 经 `ctx.systemPrompt.tools(provider)` 自动进入每次请求。
4. 设计好 **UI 呈现意图**（`generic`/`terminal`/`diff` + `locations`）——这是工具设计的一部分，presentation 是纯函数。
5. 按第 15 章补测试：单元 + 快照（真实组装 transcript）。

### 2. 加一个模型 provider

在 `ctx.llm` 上用 `ctx.effect()` 注册 adapter，实现 `LlmAdapter`（`stream` 等）。显式 `resolve` 从 settings/credentials 取配置。参考 `packages/llm/llm-deepseek/src/index.ts` 与 [`docs/cookbook/adding-an-llm-adapter.md`](../docs/cookbook/adding-an-llm-adapter.md)。

### 3. 加一个完整 seam（三件套）

按 [`docs/cookbook/adding-a-package.md`](../docs/cookbook/adding-a-package.md)：

1. **Definition 包**：`Service` 子类（抽象或具体注册表），`declare module '@deepseek-ai/cordis' { interface Context { myKey: MyService } }`，默认导出类。依赖尽量只 cordis。
2. **Provider 包**：实现它；`explicit resolve(request): Spec` 做默认值。
3. **Consumer 包**：通常是 `tool-*`，注入 Definition 服务。
4. 三包各自 README（Model Experience + Known Limitations）、`./invariant`、HMR 安全测试。

### 4. 加一段持久模型可见状态

1. 用声明合并扩展 `SessionEventMap` 加事件类型（写清 payload、是否 `SurfaceEventType`、`ignorable`）。
2. 在产生/消费处 `session.append(...)`（surface 事件必须带 `SurfaceIntent`）。
3. 在拥有的包加 `./invariant` 断言事件/数据关系。
4. 需要 UI 就注册 projection unit 或监听 `session/event`。
5. 记住：新事件类型可能构成磁盘格式破坏性变更；`assistant/` 之外新增变更要同步两个 SDK 快照。

### 5. 给一个 agent 作用域里挂独有行为

用 `agent.ctx` 注册（或在 preset 的 `setup(agentCtx)` 里注册）。它既是作用域可见性，也是生命周期绑定（dispose 撤销）。记住 scope 是**两层、扁平**——作用域注册不会向下继承给 subagent；子树行为用 lineage 数据表达。

## 三条落地纪律

1. **用 `ctx.get(name)` 取可选服务**，别用 `ctx.<name>` 属性代理（拓扑敏感）。
2. **注册返回 disposer，且证明 dispose 回收**（HMR 安全测试）。
3. **瀑布监听器必须 `next()`** 委托（除非你有决策权要短路）。

## 验证闭环

加完任何东西，跑对口径的门禁（第 15 章）：focused 单测 → 真实组装快照 → `doc-sync`（若动了文档）→ build/hygiene。别默认跑全量——CI 拥有穷尽覆盖与平台矩阵。

[第 16 章（终章）](16-learning-path.md) 给你结业的自检路线与练习清单。