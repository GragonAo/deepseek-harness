# 第 11 章 · LLM 与远程网关

> 阶段：精通。模型接入、类型图、远程调用这条「跨边界强类型」链。参考：[`docs/subsystems/llm-streaming.md`](../docs/subsystems/llm-streaming.md)、[`docs/subsystems/typert.md`](../docs/subsystems/typert.md)、[`docs/api-gateway.md`](../docs/api-gateway.md)。

## 1. LLM seam（`ctx.llm`）

Definition 是 `dsh-llm`（同时是 Consumer：它声明对话词汇）。Provider 是 `llm-deepseek` 等适配器；Consumer 是 `agent-loop`、`compaction-basic`。

**关键文件**：`packages/llm/llm/src/{index.ts,types.ts,message.ts,assembler.ts}`、`packages/llm/llm-deepseek/src/{index.ts,adapter.ts,serialize.ts,sse.ts,translate.ts}`。

### 注册：`registerAdapter` 的可逆副作用 + 原子校验

`LlmRuntime extends Service`，内部 `private adapters = new Map<string, AdapterRegistration>()`。`registerAdapter(providers, adapter)` 用 `ctx.effect()` 绑定「路由提交 + 释放」：

- `prepareRoutes` **全量校验**：provider 名非空、无重复、`providerInfo().id === provider`、`providerRetryPolicy()` 缺失时落 normal 默认。任一冲突抛 `LlmError`（`DUPLICATE_ADAPTER`/`INVALID_ADAPTER`），**全有或全无**。
- `commitRoutes` 是单一同步区段：先释放旧路由再写新路由，`llm/adapters-updated` 事件只在提交点发布一次。
- `replace()` 支持原子换路由（按配置增删 provider 的插件用）；空初始注册非法，但 `replace([])` 合法（空 settings 分节保持 0 路由注册态）。

### 消息词汇与流式

- `ContentBlockMap` **可合并扩展**（`text`/`reasoning`/`image`/`tool-call`/`tool-result`），`ContentBlock = ContentBlockMap[keyof …]`。
- `Message` 是带稳定标识的不可变值：`{ id, role: 'system'|'user'|'assistant', content: ContentBlock[], source: MessageSource }`。`MessageSource` 也可合并（`user`/`plugin`/`model`/`tool`），`kind` 回答「谁产生」，可选 `form`（`ContextFormed`）回答「这是什么信息」，**两轴独立**。
- `StreamChunk` 是**封闭**判别联合（`switch` 以 `assertNever` 收尾）：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。`index` 关联交错增量；`block-end` 携带完整组装块。
- `BlockAssembler` 是唯一共享折叠实现：`push(chunk)` 维护 `partials: Map<number, PartialBlock>`；`max-tokens` 结束时丢弃不能安全执行的 tool-call，并同步剪裁 `ReplayEnvelope.blocks`。

### 调用入口与失败规范化

`stream(options)` → `streamWithRegistration` → `ctx.waterfall('llm/stream', options, next)`，`next()` 到达把 adapter 选择/迭代失败统一归一化成终端 `finish { kind:'error'|'aborted', failure }` 分片的 `adapterStream()`；中间件/消费方失败仍保持抛出。

`prepareCall(config)` 把「模型解析 + 请求头记录 + 分派」绑定到同一项注册（HMR 不能把 A 适配器的能力结果配到 B 适配器），返回一次性 `PreparedLlmCall.stream(options)`。usage 用不相交桶 `inputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`outputTokens`。

### DeepSeek provider：显式 resolve

`packages/llm/llm-deepseek/src/index.ts`：

- `apply` 注册单一路由 `deepseek-official`。
- `resolveAdapterOptions(config, environment)`（第 161 行）是**唯一显式 resolve 步骤**：原始 config + `LaunchEnvironmentSnapshot` → 校验后的 `DeepSeekConnectionOptions`（`baseURL = config.baseURL ?? $DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL`、`apiKeyEnv = credentialRef(...)`、`models`、`streamIdleTimeoutMs`、`retryPolicy`）。每操作重新解析，配置变更下一请求即生效；解析失败保留「上次可用快照」。
- `resolveApiKey` 经可选 credential seam `ctx.get('credentials')` 解析 `CredentialRef`，失败抛 `LlmError { code: 'MISSING_CREDENTIAL' }`；snapshot 绑定保证「旧 endpoint 配不上新 key」。
- 注册顺序：`registerConfigurableProviders`（先让配置界面能展示休眠 provider）→ `registerAdapter` → `installSettingsSection`；`ensureRegistrationFacts` 用 `registration.replace()` 原位重读（retryPolicy 是注册期捕获、每请求解析无法刷新的项）。
- `adapter.ts` 的 `stream()`：`serializeRequest` 组装 OpenAI 兼容请求 → `fetch` + `parseSse` → `translate`（provider 增量 → `StreamChunk`，把 DeepSeek 的 `prompt_tokens` 拆出缓存计数、`CONTEXT_WINDOW_EXCEEDED` 归一）。

### token-meter 与 llm-replay

- `token-meter`（`ctx.tokenMeter`）：按 session 重放压力 `measure(session, requestHeader?)`，从 `request/header`/`step/start`/`assistant/message` 折叠；同时向 `sessionProjections` 注册三个投影。深冻结结果供 compaction 消费。
- `llm-replay`（`packages/test-support/llm-replay`）：`deriveReplayScript(events)` 从 `session.jsonl` 按 `finish` 切分、按首次调用顺序绑定；`ReplayAdapter` 三种变体 `chunks`/`throw`/`hang`，`assertConsumed()` 在 teardown 把「fixture 未消费完」报成清晰诊断。这是 keyless 快照测试的后端。

## 2. Typert（类型图）

`packages/typert/`：`protocol`（编译器无关协议）、`generator`（构建期生成）、`loader`（加载制品）、`registry`（`ctx.typert` 运行时注册表）。

- **`InvocationDescriptor`** 是**本地反射信息，不是 wire message**：一个导出方法的一元调用描述（`id`/`service`/`namespace`/`method`/`invocation`（`direct|context`）/`parameters`/`cancellation`/`result`）。参数带 `source: 'json'|'lookup'` 与边界 codec `TypertCodec = {mode:'strict', typeSymbol, schema} | {mode:'src-json'}`。复杂宿主对象靠声明合并扩展 `TypertLookupMap`（Host 对象 ↔ wire identity，如 Agent→agentId）与 `TypertContextMap`（作用域 Context kind ↔ wire identity）建立关联。
- **generator**（`packages/typert/generator/src/index.ts`）：`WorkspaceAnalyzer` 用 `ts.Program` 做 `check|write` 模式严格分析，把 Symbol/SyntaxNode **抽取**进编译器无关模型（`ServiceModel`/`InvocationModel`/`SchemaModel`），产生每 face 制品：Host 侧 `typert.host.js/.d.ts` 与 Host-for-Client 侧 `typert.remote-client.js/.d.ts`。约束：Remote 必须是公共、非静态、有实现、非泛型实例方法；参数具名必填简单标识符；复杂对象必须有唯一 `TypertLookupMap` 声明。
- **loader**（`packages/typert/loader/src/index.ts`）：跟 `internal/plugin` 增量扫每个 entry 的 `package.json` `exports['./typert']`，动态 `import()` host face，经 `validateTypertManifest()` 逐字段校验后 `ctx.typert.register(manifest)`；卸载撤回。手动 `ctx.typert.register()` 仍可用于无 `./typert` 的贡献。
- **registry**（`packages/typert/registry/src/service.ts`）：`register(contribution)` 原子写入 `schemas`/`packages`/`local` 三张表，任何重复整体拒绝，返回 exact disposer。四个子注册表：`DescriptorStore`（描述符）、`RemoteStore`（client 贡献）、`LookupStore`（lookup 提供方）、`ContextStore`（Host context resolver + Client context binder）。

解决的问题：**跨进程/远程 RPC 的类型安全**——浏览器用「从 Host 源码生成的同源 schema」对每个 wire 字段做严格 zod 校验，Host 用同一份描述符校验入参、解析 lookup、调用 live 服务、再校验返回值；两侧同一 endpoint 描述符各自编译但逐字段对齐，绕开「跨进程没有共享类型」。

## 3. API 网关（`ctx.typertGateway`）

`TypertGatewayService`（`packages/api/gateway/src/index.ts`）注入 `typert` 并拦截 Connection RPC：

```ts
connectionCtx.connection.rpc.intercept(
  '/api',
  endpoint => this.claimsEndpoint(endpoint),
  (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal),
  { authority: 'trusted-host' },
)
```

`invoke(request)` 控制流：`resolveDescriptor`（先查 `typert.local`；`hasSeen` 但已撤回 → `definition-unavailable` 拒绝降级 SRC；否则 `resolveSrcDescriptor` 从 `ctx.reflect.props` + `remoteMethods()` 弱推）→ `assertExactArguments` 逐字段匹配 → `resolveReceiverContext`（`direct` 用根 ctx；`context` 用 `typert.contexts` 解析 scope identity）→ `ctx.get(descriptor.service)` 取 live 服务 → `validateBinding` → 逐参数 `resolveParameter`（`decode` 校验；lookup 再经 `typert.lookups` 解析对象）→ `Reflect.apply` → `decode(result)`。`decode` 对 strict codec 先 `schema.parse` 再 `assertJsonValue`（禁循环/稀疏数组/symbol/非 plain object）。失败映射 `TypertGatewayError` 的 17 种 code（`input-invalid`/`service-unavailable`/`lookup-not-found`/`provider-mismatch`…）。

Client 侧 `ctx.remote.$mount(contribution)`：`typert.remotes.register` 后为每个描述符在 `remote.<namespace>` 子服务上 `Object.defineProperty` 一个 concrete 方法（**无 JS Proxy**），`invoke()` 用 Client Context binder 解析 scope identity 后 `connection.rpc.call('/api', endpoint, { args }, signal)`。HTTP 载体即 `POST /api/<namespace>/<method>`。

`api/remotes` 是唯一拆 TS face 的包：运行时依赖 `remotes → gateway → connection → webserver`；Host project（`apply(): void {}` 空体，BFF 策略在 `agent-lookup.ts`）管 Agent/Session lookup 策略，Client project `$mount` 五个 `/remote` 贡献。

## 4. SDK（JSON-RPC，进程外驱动）

- **协议**（`packages/sdk/protocol`）：三对请求/结果 `initialize` / `session.prompt` / `shutdown` + 四条通知 `session.event` / `session.status` / `subagent.started` / `subagent.finished`。`JsonRpcLineTransport` 在 stdio 字节流上做换行分隔 JSON-RPC 2.0；缺 handler 回 `-32601`、失败回 `-32603`，`request(..., signal)` 用 `AbortSignal` 做「放弃」（移除 pending、保留服务端跑完）。
- **server**（`packages/sdk/server/src/server.ts`）：`HarnessSdkJsonRpcServer` 订阅 `session/event`/`agent/status`/`session/created`/`subagent/end` 并转发通知；`initialize` 记录 route、无该 adapter 且 provider 是 `deepseek-official` 时挂 fallback adapter；`prompt` → `getOrCreateSession` → `ctx.agents.create` → `followup`。`shutdown` 幂等完成 agent 释放与订阅解除。
- **client**（`packages/sdk/client/src/client.ts`）：`HarnessClient` 拥有子进程（直接 `spawn`，不经 `dsh-subprocess`）；`start()` 懒起进程，`close()` 先协议 shutdown 再走 EOF→SIGTERM→SIGKILL 的 dispose 阶梯。
- **`subagent-dsh-sdk`** 是它的**消费方**：`SdkSubagentProvider` spawn 一个完整进程外 harness（自己的 cordis.yml/会话/路由/工具），`inheritsParentContext = false`。

## 5. ACP（自动化协议）

`packages/acp/acp/src/index.ts`：`@deepseek-ai/dsh-acp` 用 `@agentclientprotocol/sdk` 的 `AgentSideConnection` + `ndJsonStream` 把 harness agent 暴露给程序化客户端。`makeAgent` 返回 `initialize`（广告 `promptCapabilities.image`，经 `llm.resolveModelInfo` 的 `inputModalities` 判定）/`newSession`（校验 cwd 绝对路径）/`prompt`/`cancel`。`prompt` 只把 **committed** 文本/图片上 wire（raw chunk、reasoning、工具调用、plan、title、retry 标记一律不下发），`settleAfterQuiescence` 等 quiescence 后才 resolve stop reason。

审批桥：ACP 监听 `approval/request` waterfall，用 `conn.requestPermission` 提供一次性三态并**短路**（不 `next()`）——`allow-once`/`reject-once`/`cancelled`。机器策略只给「允许一次/拒绝一次/取消」，绝不从未知客户端响应推断持久授权。

## 一张图串起来

```
浏览器 / 外部进程 / ACP client
        │ Connection RPC / JSON-RPC / ACP stdio
        ▼
ctx.typertGateway ── resolve 身份 ──► Remote 描述符（Typert 生成）
        │ invoke
        ▼
实时 Cordis 服务（ctx.llm / ctx.agents / …）
```

三条链共享同一 host/loop 模型：**LLM** 是 seam（注册 adapter + `llm/stream` waterfall + 封闭 `StreamChunk`）；**Typert** 是「从源码生成契约 + 运行时注册 zod 贡献」的类型安全层；**gateway** 把这些契约挂到 `rpc.intercept('/api')` 的一元 RPC。所有注册都是 `ctx.effect()`/`ctx.on()` 可逆副作用；边界校验立场一致——同进程 typed 边界信 TypeScript，wire/parser/durable 边界才校验（strict zod + `assertJsonValue` + loader 逐字段 manifest 校验）。

## 关键文件

- `packages/llm/llm/src/index.ts`（`LlmRuntime`、`registerAdapter`、`prepareCall`、`llm/stream`）
- `packages/llm/llm-deepseek/src/index.ts`（`resolveAdapterOptions`）+ `adapter.ts`/`translate.ts`
- `packages/typert/registry/src/service.ts`（`ctx.typert`）、`packages/typert/generator/src/index.ts`
- `packages/api/gateway/src/index.ts` + `src/client/index.ts`（gateway、`ctx.remote`）
- `packages/sdk/server/src/server.ts` / `packages/sdk/client/src/client.ts`
- `packages/acp/acp/src/index.ts`

下一章回到耐久层：会话如何持久化、投影、查询。