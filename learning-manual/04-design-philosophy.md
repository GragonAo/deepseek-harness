# 第 4 章 · 设计思想

> 阶段：理解。本章回答「为什么这么设计」。它把散落在架构文档、术语表、防御性模式与 Agent Notes 里的设计决策聚成一张清单。每条给出「是什么 / 为什么 / 落地位置」，并标注**一手决策记录**（Agent Note 相对路径），方便你深挖「当初取舍了什么」。

设计决策的一手记录在 [`.agents/notes/`](../.agents/notes/README.md)（`implemented/` 描述已落地的现实，用现在时）。本章是它的导读式索引。

## 1. 一切都是插件，无可修补的特权核心

**是什么**：模型适配器、工具注册表、会话日志、agent 循环本身，全部是插件，全部可从 `cordis.yml` 配置替换。循环的扩展点是一套带刻意派发模式的类型事件；唯一具体循环插件 `@deepseek-ai/dsh-agent-loop` 本身可替换，核心之外谁也不许依赖它。

**为什么**：hooks、goal、动态工作流、compaction、沙箱、权限、UI、持久化、skill 都能不改核心地写成插件；「挂一个插件」就是唯一扩展方式。

**落地**：[`docs/architecture.md`](../docs/architecture.md#cordis)、[`vendor/`](../vendor/README.md)。
**决策记录**：[`2026-06-11-microkernel-event-taxonomy.md`](../.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md)、[`2026-07-16-harness-level-loop.md`](../.agents/notes/implemented/feature/2026-07-16-harness-level-loop.md)（goal/Ralph 是显式插件策略，不是泛化 loop 服务）。

## 2. 事件溯源：会话日志是唯一事实源

**是什么**：`Session` 是 append-only 的类型化 `SessionEvent` 日志；LLM 消息历史由 `deriveMessages()` **派生**，replay/fork = 用已有日志种子化新会话。追加是同步的（热路径不阻塞 IO），持久化是 write-behind 到 `session/flush` 检查点。

**为什么**：因为「日志就是状态」，state/log 漂移在结构上不可能（对照可变的 message 数组）。版本、cwd、血缘等存储元数据放在日志外的 `SessionHeader`，不进可回放状态。

**落地**：[`docs/subsystems/session.md`](../docs/subsystems/session.md)、[第 12 章](12-session-data-plane.md)。
**决策记录**：[`2026-06-11-event-sourced-sessions.md`](../.agents/notes/implemented/architecture/2026-06-11-event-sourced-sessions.md)、[`2026-06-14-session-persistence.md`](../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)、[`2026-06-11-dev-invariants-over-deep-readonly.md`](../.agents/notes/implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md)。

## 3. 能力 seam 三角色

**是什么**：可替换能力 = **Service Definition** + **Service Provider** + **Consumer** 三角色，按「变率不同」拆包。Definition 是 Cordis `Service`（从不 `interface`），Provider 实现它，Consumer `inject` 服务键且**永不 import provider 类型**——换沙箱 executor 不变工具 schema。seam 指三者整体；不「预先拆」，真正同关注点时保持折叠（`dsh-llm` 折叠 Definition 与 Consumer）。

**落地**：[`docs/capability-seams.md`](../docs/capability-seams.md)、[第 9 章](09-capability-seams.md)。
**决策记录**：[`2026-06-13-capability-seams.md`](../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)。

## 4. model-visible ⟺ 已持久引用

**是什么**：到达模型请求的一切都能由会话日志 + 其引用的内容寻址对象**逐字节重建**。`EpochHeader` 记录非历史态（调用配置、渲染系统提示、工具 schema），`request/header` 每次写全量快照；`dsh-agent-loop/invariant` 用独立新鲜 `Session` 重放并逐字段比对。

**为什么**：请求可重建 => 迁移/审计/回放可与运行路径重合；prefix-cache 稳定是「涌现的」而非被管理的。拒绝逐调用可变 config（会静默放弃 provider 缓存）。

**落地**：[`docs/architecture.md`](../docs/architecture.md#session-log)、根 [`AGENTS.md`](../AGENTS.md#conventions)。
**决策记录**：[`2026-07-05-reconstructable-requests.md`](../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)。

## 5. 三大事件域，各一个职责，一条边界规则

**是什么**：`session/*` 是耐久可回放的事实日志（只 JSON，无活对象）；`agent/*` 是携带活 `Agent` 的实时拦截面；`tools/*` 是工具注册与执行管道。边界规则：**耐久可回放事实 = `SessionEvent`；实时拦截/瞬态 = `agent`/`tools` 事件**。

**为什么**：turn/step 边界只在会话日志，读 `session/event` 流，**不再镜像**成 `agent/*` emit（删掉边界孪生），使实时渲染与回放投影共享一条路径。

**落地**：[`docs/architecture.md`](../docs/architecture.md#events)、[第 8 章](08-events-and-types.md)。
**决策记录**：[`2026-06-30-event-domain-semantics.md`](../.agents/notes/implemented/architecture/2026-06-30-event-domain-semantics.md)。

## 6. 类型事件用声明合并；判别标签 switch；闭合联合 assertNever

**是什么**：消息是类型化 content block 数组，联合由可 merge-extensible 的 `ContentBlockMap` 派生，插件靠声明合并加块类型；同一 `…Map → union` 模式为所有「字符串型」字段类型化。消费方对判别标签 `switch`；闭合联合收尾 `assertNever`（渲染意图用 `card`-tagged 判别联合，非法组合不可表示、新意图 = 编译失败信号）。

**落地**：[`docs/subsystems/core.md`](../docs/subsystems/core.md#the-map--derived-union-pattern)、[第 8 章](08-events-and-types.md)。
**决策记录**：[`2026-06-11-content-block-vocabulary.md`](../.agents/notes/implemented/architecture/2026-06-11-content-block-vocabulary.md)、[`2026-07-02-tool-render-intent-union.md`](../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md)。

## 7. 注册是可逆副作用；注册起点决定可见性与清理

**是什么**：每个贡献都走 `ctx.effect()` / `ctx.on()`，registry 的 `register()` 返回 disposer（HMR + 释放免费获得）。扩展：通过普通插件 context 注册 = 部署全局、随插件销毁；通过 `agent.ctx` 注册 = 恰好该 agent、随 agent scope 销毁；操作经 owning service 的合并规则选「globals + 该 agent 层」。

**落地**：[`docs/cordis-primer.md`](../docs/cordis-primer.md)、[第 2 章](02-cordis-foundation.md)。
**决策记录**：[`2026-07-08-agent-scope-contexts.md`](../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md)。

## 8. 显式 > 隐式：`resolve(request): Spec`

**是什么**：默认化是 owning 实现里显式的 `resolve(request): Spec` 步骤，绝不藏在 `run()` 里的 `?? default`。`dsh-shell` 的请求/spec 拆分是模板；完整策略（如 `sandboxPolicy`）随每个 call。zero-config 也是「wrapper 里可见的一次参数传递」，而非 runtime 里的隐藏回退（Python SDK 注入 `DSH_CORDIS_CONFIG`，runtime 无显式配置则 loudly 退出）。

**落地**：[`docs/subsystems/shell.md`](../docs/subsystems/shell.md)、根 [`AGENTS.md`](../AGENTS.md#conventions)、[第 9 章](09-capability-seams.md)。
**决策记录**：[`2026-07-06-sandbox.md`](../.agents/notes/implemented/feature/2026-07-06-sandbox.md)。

## 9. 不透明跨边界 ID 品牌化

**是什么**：用零成本 cast 型 `Branded<B> = string & { readonly [BRAND]: B }` 阻止「结构相同、语义错」的串混淆，尤其模型可见或用于访问控制的 id（`BashTaskId`、`OwnerToken`、`CallId`、共享 `SessionId`）。品牌只挡「错误的种类」，不是正确性证明。

**落地**：[`docs/subsystems/core.md`](../docs/subsystems/core.md#branded-ids)、[`dsh-brand`](../packages/util/brand/README.md)。
**决策记录**：[`2026-06-20-branded-ids.md`](../.agents/notes/implemented/architecture/2026-06-20-branded-ids.md)。

## 10. 每包 invariant：断言关系，而非形状

**是什么**：每个 workspace 包发布独立 `./invariant` companion 并登记精确 npm 名。有价值的运行时不变式关联「跨时间/跨可变结构的观察」（事件的 start/pair、delta 对 open block、durable result 的 identity 匹配请求）；方法存在性/插件名/固定纯例不构成。无合理关系的纯工具/composition 包用「带解释的空 installer」。

**落地**：[`packages/AGENTS.md`](../packages/AGENTS.md)、[`docs/subsystems/invariants.md`](../docs/subsystems/invariants.md)。
**决策记录**：[`2026-07-19-package-invariant-runtime-contracts.md`](../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.md)。

## 11. 单一执行世界

**是什么**：文件系统与子进程 provider 共享同一个执行世界。沙箱 seam 只约束「同世界」子进程；容器/微 VM/远程 executor **不是**本 seam 的后端，而是把 `ctx.shell`/`ctx.fs` 整条 seam 替换为环境 coherent 组（否则 bash 在容器里跑、fs 工具写宿主 = 割裂世界）。web/todo 在进程内执行，execve wrapper 无意义——用各自 capability 边界的 policy。

**落地**：[`docs/architecture.md`](../docs/architecture.md#capability-seams)、[第 10 章](10-execution-world.md)。
**决策记录**：[`2026-07-06-sandbox.md`](../.agents/notes/implemented/feature/2026-07-06-sandbox.md)。

## 12. canonical value 与模型可见投影分离

**是什么**：每个工具声明强制 canonical output（`schema`/`render`/`presentationMeta`），只返回按它描述的值；成功派发快照为 lossless `JsonValue`、校验、深冻结，`render` 是纯函数投影。`tools/post-execute` 两种互斥成功投影——替换 `content` 只改演示保留值，替换 `value` 重校验重投影。中间值是**执行期本地**的：`tool/result` 只持久化 `content`/`error`/`meta`，回放保演示但不重建程序结果（显式属性而非意外缺口）。

**落地**：[`docs/subsystems/tools.md`](../docs/subsystems/tools.md)、[第 7 章](07-tool-pipeline.md)。
**决策记录**：[`2026-07-20-canonical-tool-output-contract.md`](../.agents/notes/implemented/architecture/2026-07-20-canonical-tool-output-contract.md)。

## 13. 所有权契约 + 完全停稳 teardown

**是什么**：想拥有/销毁 agent 的调用方从工厂拿 `AgentHandle { agent; dispose() }`（disposer 是 consumer capability），队列感知的 `cancel()` 是唯一公开停止原语。teardown 顺序承载耐用性（loop 停止并 `await done` 在 session 分离之前，单一复合 cordis effect 的有序 LIFO 链捕获关闭 `turn/end`）。

**落地**：[`docs/subsystems/core.md`](../docs/subsystems/core.md#creation-and-ownership)、[`docs/defensive-patterns.md`](../docs/defensive-patterns.md)。
**决策记录**：[`2026-06-18-agent-lifecycle-and-ownership-contracts.md`](../.agents/notes/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-contracts.md)。

## 14. 持久元数据在日志外、格式发布冻结

**是什么**：format version、cwd、血缘是存储关切而非会话重放状态，放 `SessionHeader`（`session.header`），永不进 `SessionEventMap`/`deriveMessages()`。持久化本身是 capability seam（抽象 `SessionPersistence` + JSONL/SQLite 两个后端过同一 `runPersistenceContract`），共享 `PersistenceCoordinator` 组合（非继承）拥有后端无关的 write-behind 编排。

**落地**：[`docs/subsystems/persistence.md`](../docs/subsystems/persistence.md)、[第 12 章](12-session-data-plane.md)。
**决策记录**：[`2026-06-14-session-persistence.md`](../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)、[`2026-06-18-shared-persistence-write-coordinator.md`](../.agents/notes/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md)。

## 15. 机器可检查的不变量 + 单一来源显式清单投影

**是什么**：前半——把散文约定转成 exit-非零命令；coding-agent 遵循强制门禁远可靠于遵循散文。`ts.Program` 语义门禁让事件关系从 receiver/value 类型而非命名约定导出，语义缺口显式失败、生成产物进提交树。后半——文档事实「一个可编辑的家」，`website/docs.ts` 是审查可见的 allowlist 清单，投影器把清单投影进被忽略的 `.generated/` 并把链接改写为站内/GitHub，杜绝第二份会漂移的文档树。

**落地**：[`docs/testing.md`](../docs/testing.md)、[`scripts/`](../scripts/)、[第 15 章](15-engineering-practices.md)。
**决策记录**：[`2026-06-11-quality-gates.md`](../.agents/notes/implemented/process/2026-06-11-quality-gates.md)、[`2026-07-14-typescript-program-backed-semantic-gates.md`](../.agents/notes/implemented/process/2026-07-14-typescript-program-backed-semantic-gates.md)、[`2026-07-13-documentation-site-projection.md`](../.agents/notes/implemented/process/2026-07-13-documentation-site-projection.md)。

<a id="defensive-patterns"></a>

## 补充：防御性模式（已付学费的缺陷类）

写生命周期/并发/子进程/teardown 代码前必读 [`docs/defensive-patterns.md`](../docs/defensive-patterns.md)，共七条（不在上面 15 条原则之内）：

1. **正交结果独立上报**：进程可能既超时又退出码 0；`timedOut`、`signal`、`exitCode` 各自独立上报，互不嵌套分支。
2. **公共约定两侧都要遵守**：实现收到多种表示时返回前规范化（`LlmAdapter.stream()` 的失败统一成终止型 finish 分片）。
3. **异步状态不是同步状态**：`agent.followup()` 没有逐消息完成状态与结果；别把 `whenIdle()` 当某次 `followup()` 的结果，拥有一次运行的调用方要显式定义区间。
4. **dispose 必须完全停稳**：等子进程退出、先关监听/通知注册表；只发停止信号就返回会留下孤儿进程。
5. **在分发器中隔离回调异常**：监听器抛错不得导致所在 promise reject，也不得饿死后续监听器。
6. **绝不把环境变量/可预测路径暴露给不可信输出**：清理 `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`，spill 用 0700 私根 + 随机名 + 独占只读打开（`'wx'`/`0o600`）。
7. **用 unlink 删链接形态的路径**：先 `lstatSync().isSymbolicLink()` 判断再 `unlinkSync` 删除——unlink 只删链接本身并拒绝真实目录，绝不跟随链接进入目标。

## 小结

如果只背三句：**模型可见 ⟺ 已入日志**；**能力 = 三角色 seam，换 provider 即换能力**；**注册是可逆副作用，一切皆插件**。它们的推论（日志唯一真源、单一执行世界、事件声明合并、品牌 ID、canonical 值与投影分离、每包 invariant、机器可检查门禁）构成了 dsh 其余所有代码的形状。

下一章开始下沉到源码：主干六包逐个精读。