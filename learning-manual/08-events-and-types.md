# 第 8 章 · 事件系统与类型模式

> 阶段：深入源码。读完你能在任何位置判断「这件事该用哪个事件/哪种类型机制表达」。

本章汇聚两个主题：**事件**（dsh 的扩展点语言）与**类型模式**（dsh 的可扩展性是如何在类型系统里实现的）。参考：[`docs/architecture.md`](../docs/architecture.md#events)、[`docs/cordis-primer.md`](../docs/cordis-primer.md)、[`docs/subsystems/core.md`](../docs/subsystems/core.md)。

## 三层事件：先选对域

大多数改动的第一步是选对事件域（[`docs/architecture.md`](../docs/architecture.md#events)）：

| 域 | 例子 | 何时用 | 生命周期 |
|---|---|---|---|
| 会话事件 | `turn/start`、`user/message`、`assistant/message`、`tool/result`、`todo/write` | 事实要跨 reload 存活 | 持久，追加进日志 |
| Agent 事件 | `agent/status`、`agent/pre-step`、`agent/request`、`agent/turn-stopping` | 观察/拦截在途工作 | 实时，携带 `Agent` |
| 能力事件 | `fs/write-intent`、`tools/pre-execute`、`llm/stream`、`telemetry/*` | 给某个 seam 挂政策/适配器 | 实时，不导入循环 |

判断口诀：**要持久 → 会话事件；拦截在途 → agent 事件；给 seam 挂政策 → 能力事件。**

## 事件怎么声明：声明合并

服务通过 TypeScript 声明合并注册事件名（[`docs/cordis-primer.md`](../docs/cordis-primer.md)，[`docs/rescope.md`](../docs/rescope.md)）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'fs/write-intent'(this: Scoped<Session>, ...args: ...): ...
  }
}
```

于是插件在不修改核心包的前提下扩展全局 `Events` 接口，类型安全地新增事件，跨包也能看到。每个 harness 事件的 JSDoc 必须写 `@mode`（标注分发模式），生成的目录据此交叉校验「声明的模式」与「实际 dispatch 调用」。

## 四种分发模式

已在[第 2 章](02-cordis-foundation.md)讲过，这里补上「在 dsh 里分别对应什么」：

- `emit`：绝大多数生命周期通知（`session/event`、`agent/status`、`agent/created`）。
- `waterfall`：可改写决策的环绕点（`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`）。监听器**必须 `next()`**。
- `parallel`：并行耐久检查点（`session/flush`）。
- `serial`：无否决权的终端检查点（`agent/turn-stopping`，无 `next()`）。

完整矩阵（每个事件的 producer/consumer 与声明文件位置）见 [`docs/event-producer-consumer.md`](../docs/event-producer-consumer.md)——它是从 TypeScript Program 生成的，因此永远与源码同步。

## `…Map → 派生联合` 模式

dsh 几乎所有可扩展的和类型都遵循同一模式（[`docs/subsystems/core.md`](../docs/subsystems/core.md#the-map--derived-union-pattern)）：

```ts
interface SessionEventMap {
  'turn/start': { turn: number }
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  // …插件可用声明合并继续加
}
type SessionEventType = keyof SessionEventMap          // 'turn/start' | 'tool/call' | …
type SessionEvent = SessionEventMap[SessionEventType]  // 判别联合
```

六个规范 map（插件扩展它们）：`ContentBlockMap`、`MessageSourceMap`、`FinishReasonMap`（dsh-llm）、`TurnTriggerMap`、`TurnEndReasonMap`、`SessionEventMap`（dsh-session）。

消费方对判别标签做 `switch`，每个分支窄化类型；拼错标签编译失败。**注意**：`SessionEventMap` 可合并扩展，所以对 `SessionEvent` 的 switch **禁止用 `assertNever`**——插件的变体是合法的未知值，处理已知 case 后放行 `default`。

## 会话事件词汇（速查）

完整词汇与每个 payload 见 [`docs/subsystems/session.md`](../docs/subsystems/session.md)。核心事实：

- `SessionEvent` 是**真正的判别联合**（基于 `type`，不是独立的 `type`/`data`），`switch (event.type)` 直接窄化 `event.data`。
- 每条条目带单调 `seq`（=`log.length`，连续）与 `time`（epoch 毫秒）。
- 三种产生 LLM 消息的类型叫 **Surface 类型**：`user/message`、`assistant/message`、`tool/result`。只有它们携带 `surfaceOp` 与 `sourceEventSeqs`。
- `surfaceOp` 有 `'append'`（尾部追加）与 `{ op:'replace', start, end }`（压缩 summary 遮蔽一段 surface）。
- `ignorable: true` 标记「读者不认识此 type 时可安全跳过」的纯信息事件；缺省为 required，读者遇到不认识且无此标记的事件**必须拒载**。

### 事件变体速记

| 事件 | 内容 |
|---|---|
| `turn/start` | `{ turn }` 打开轮次 |
| `turn/end` | `{ turn, reason: TurnEndReason }` 关闭轮次 |
| `step/start` / `step/end` | `{ turn, step }` 一步的边界 |
| `user/message` | 模型可见 user-role 消息（人类/注入上下文/目标续行） |
| `assistant/chunk` | 原始流分片（token 级回放保真） |
| `assistant/message` | 组装后的助手消息（派生历史用它，带 `usage`） |
| `tool/call` | 模型请求一次工具调用（`name` + 未解析的 `arguments` 字符串 + `callId`） |
| `tool/result` | 工具结果（面向模型的结果 + 可选 `error` + 可选 `meta`） |
| `todo/write` | 整张 todo 列表快照（latest-write-wins，仅日志） |
| `request/header` | 下一请求的完整信封快照（调用配置+系统提示词+tools） |
| `request/context` | 路由容量元数据（仅当 provider/model/容量变化时记） |
| `session/end-seed` | 构造种子结束边界（`firstLiveSeq` 的持久投影） |

## 历史派生规则（`deriveMessages`）

`Session.deriveMessages()` 把日志投影成 `Message[]`（[`docs/subsystems/session.md`](../docs/subsystems/session.md)）：

- `user/message` → user 消息；注入上下文按时间顺序、原样承载 `content`、`source` 标明生产方。
- `assistant/message` → assistant 消息（原 `assistant/chunk` 是回放/UI 数据，派生时**跳过**）；**空内容的** `assistant/message` 也跳过，但仍保留用量记账。
- `tool/result` → 带 `tool-result` 块的 user 消息。
- 其余事件（`turn/*`、`step/*`、插件日志事件）都是结构信息，不投影成消息。

缓存与冻结：每个 surface 节点投影一次；`replace` 触发重建；返回的 `Message[]` 每次是新数组，其中 `Message` 共享且深冻结——通过投影改不了历史。

## 品牌化 ID

跨包 ID 一律品牌化（[`docs/subsystems/core.md`](../docs/subsystems/core.md#branded-ids)）：

```ts
type Branded<B extends string> = string & { readonly [BRAND]: B }  // dsh-brand
```

`SessionId`、`CallId`、`JobId` 结构上是字符串，类型上不可互换。纯类型、零依赖的 [`dsh-brand`](../packages/util/brand/README.md) 提供原语。

## 作用域分发（scope-filtered dispatch）

很多会话/agent 事件带 scope 过滤分发（JSDoc 里 `@deepseek-ai/dsh-scope`）：事件以对应 agent 的 **scope carrier** 分发，agent 作用域内的监听器只收到自己 agent 的事件。scope 原语的机制在第 5 章精读；注意「注册表本身的事件」（如"一个工具被添加了"）属于注册表主体事件，故意保持不过滤。

## 小结

- 三层事件选域 → 用对应 dispatch 方法 → 写对 `@mode`。
- 新会话事件 = 加 `SessionEventMap` 变量，写 payload、surface 标记、`ignorable`，然后在拥有的 `invariant` 里断言它的事件/数据关系。
- 所有可扩展和类型走 `Map → union` + 声明合并；对可扩展联合 switch 时用 `default` 而非 `assertNever`。

本章讲的类型与事件机制，正是下一章「能力 seam」三件套在类型层与通信层的地基。