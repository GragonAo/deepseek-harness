# 第 5 章 · 主干六包源码精读

> 阶段：深入源码。这一章带你逐包读 `packages/core/` 六大主干。官方参考页：子系统的 [core](../docs/subsystems/core.md)、[session](../docs/subsystems/session.md)、[system-prompt](../docs/subsystems/system-prompt.md)、[tools](../docs/subsystems/tools.md)、[scope](../docs/subsystems/scope.md)。

读这章请开着源码：每个包给「目录要点 → 关键类型/函数 → 控制流」，路径以 `packages/core/<pkg>/src/` 为根。

## 1. session —— 事件溯源日志

文件：`types.ts`（词汇）、`surface.ts`（surface 投影）、`index.ts`（`Session` 类 + `SessionStore`）。

**机制**：`SessionEventMap` 接口声明合并 → `SessionEventType = keyof` → `SessionEvent` 派生的判别联合。`Session` 是纯内存 `log: SessionEvent[]` + 一个 `SurfaceManager`。第 8 章已讲词汇与 surface，这里补实现要点：

- `append(type, data, opts)` 一次递归 JSON 校验（丢 BigInt/函数/循环引用等）→ 深冻结 → 发布 `session/event`。**热路径从不阻塞 I/O**：持久化插件订阅 firehose 异步缓冲。
- `deriveMessages()` 是**缓存**投影：逐节点由 `surface.ts` 的 `deriveEventMessage` 折叠，每个 surface 节点投影一次，`replace` 触发重建。
- `surface`（`SessionSurface`）返回只读 nodes + `replaceGeneration`；`Session` 构造时用一个只含已加载窗口的 `SurfaceManager(log, baseSeq?)`。

**store 侧**：持久化**故意不在这里实现**——持久化插件订阅 `session/event`，在 `session/flush`/dispose 时落盘。`SessionStore` 的关键方法：`create` / `prepare`+`enter`+`announce`（把会话生命周期折进调用方自己的 effect，保证卸载顺序）/ `flush(session)`（唯一 flush 入口，承载 scope carrier）/ `fork(source, boundary?, childSessionId?)`。

## 2. system-prompt —— 提示词组装

文件：`index.ts`。

**机制**：`PromptSection`/`PromptContext` 经 `ScopedLayers` + `NamedEntries` 注册（作用域感知的命名片段层）。`assemble()` 合并 scope 链、排序、跑 `system-prompt/assemble` waterfall（监听器可改写）。工具 schema 经 `systemPrompt.tools(provider)` 以 `ToolProviderResult` 进入（provider 可以贡献「我不认得的工具的 schema」）。

这就是「插件贡献提示词片段」的落地：注册一个 section，它自动进入每次请求的前缀组装，且可被 agent-scope 遮蔽（shadowing）。

## 3. tools —— 注册表 + 守卫执行

文件：`index.ts` 为主。

**核心类型**：`ToolDefinition`（面向模型的 `ToolSchema` + `execute` + 可选 `finalizeContent` + UI 回调）。工具作者用 `defineTool` DSL 构造，很少手撸 `ToolDefinition`。

**执行管线**（`ToolRuntime.execute`，第 7 章展开）：

```text
tools/pre-execute (waterfall → serviceAsk → monotonic guard)
  → tools/execute (around-dispatch，融合取消 signal；timeout-policy 在此包装 timeoutMs)
  → tools/post-execute (waterfall)
  → finalizeContent (定义自带的、同步、仅内容不变式)
  → tools/result (同步通知，冻结的权威结果)
```

**作用域**：`view()` 做 restriction 交集 + 本作用域豁免 + `run_code` 传输；被过滤的全局工具「既不进提示词，也拒绝执行，与不存在不可区分」（[glossary](../docs/glossary.md) scope）。**Code Mode** 靠 `collapses()` 折叠保留的 `run_code` 传输及其序列化子调用进入同一条流水线。

## 4. agent —— 接口 + 实时注册表

文件：`runtime-types.ts`（事件词汇）、`index.ts`（`AgentRegistry`）、`inbox.ts`、`dispatch.ts`。

**核心**：

- `Agent` 接口（第 3 章已列全签名）：`id/options/session/inbox/status/ctx` + `cancel/whenIdle/runMaintenance/send/followup/steer/inject`。
- `AgentRegistry`（`ctx.agents`）：用 **`AsyncLocalStorage`** 实现「发起者作用域」（进程本地因果归属）——`withInitiator(agent, op)`、`requireInitiator()`、`withoutInitiator()`。
- `AgentHandle` = 归属所有者的句柄（`agent` + `dispose()`）；`dispose()` 停循环→await 退出→注销→移除会话→回收作用域世界。
- 发布顺序：`enter(agent, owner)`（静默插入）→ `announce(agent)`（发 `agent/created`）；`agent/created` 的同步监听器抛错则回滚发布。
- `agent.inject()` = 投递到 `next-step` 且**不唤醒**，等下次 followup/steer 唤醒时被认领。

## 5. agent-loop —— 具体循环

文件：`agent.ts`（循环 agent）、`index.ts`（factory/驱动接线）、`tool-calls.ts`（工具批次）、`runtime-context.ts`。

**核心**：`ReactLoopAgent`（实现 `Agent` 而外无人依赖此具体类，扩展插件只依赖 `dsh-agent`）。文件：`agent.ts`（驱动器）、`index.ts`（`AgentLoop` 工厂）、`tool-calls.ts`（工具调度）、`runtime-context.ts`（动态上下文快照）、`constants.ts`。

内部是一台相位机 `Phase = 'idle' | 'maintenance' | 'running'`（`agent.ts:38`）：`wakeDriver` 在 idle 时置 running 并 `withInitiator(this, ()=>this.kick())`，`kick` 循环 `while(await turn())`。三个方法：

- `turn()` —— `turn/start` → 循环 `preStep(target)` → `step/start` → 逐条 `user/message` → `step()` → `step/end`；`finally` 恒 append `turn/end`（reason 由成功/取消/错误/`max-tokens`/blocked 判定）。
- `step()` —— `buildRequest()` → `agent/pre-step` 之外的请求型 waterfall 链 → `llm/stream` → `assistant/*` → `executeToolCalls()` → `step/end`。
- `buildRequest()` —— 从 `session.requestHeader()` 折出上一请求头，`seedConfig` 经 **`agent/request` waterfall** → `llm.prepareCall` → `canonicalHeader` 与基线 `headerEquals` 比较，按需 `request/header`（reason `initial|resume|change`）+ `request/context` → `markAgentLoopRequest({...config, messages: session.deriveMessages()})`。

`agent/pre-step`、`agent/request`、`agent/request-error` 均经 `dispatch.waterfall` 接线（第 8 章）。历史由 `session.deriveMessages()` 导出。工具经 `executeToolCalls` **按 `exclusive`/`parallel` 分组**（`exclusive` 单独 barrier），用上限 `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10` 的有界滚动池**并行执行、按模型顺序提交结果**（第 7 章）。

第 6 章把 `turn()/step()` 展开成完整旅程。

## 6. scope —— 作用域注册原语

文件：`index.ts`、`store.ts`。这是六包里唯一的**非服务包**（零依赖库，模块图中低于 session/system-prompt 以免成环）。

**核心**：

- `ScopeKey`（按对象同一性比较的不透明标识）+ `scopeTarget`（事件沿父链向上分发）。
- `bindScopeParent`（遮蔽/继承双方向）+ `createScope`（fiber + tag）。
- `ScopedLayers.effect` **就是 setup window**：注册即得「作用域可见性 + effect 所有权」，dispose 撤销并回收空层。

这套原语被 session/system-prompt/tools 复用，实现「工具/片段/变量的 agent-scope 与 shadowing」。

## 小结

六个包串成一行：**scope 提供作用域原语 → session 提供日志真源 → system-prompt 组装前缀 → tools 提供守卫执行 → agent 定义接口与归属 → agent-loop 驱动循环**。记住 dependencies 方向：扩展插件依赖 `dsh-agent`（事件/服务），绝不依赖 `dsh-agent-loop`（循环可替换）。

下一章把第 5 章第 5 节的 `turn()/step()` 展开成一次真实旅程。