# 第 16 章 · 进阶路线与练习

> 结业。一条可执行的深挖路线 + 十个动手练习 + 一个自检表。

## 源码阅读顺序（从入门到精通的推荐路线）

1. `docs/cordis-tutorial/`（01→07）——先动手写出第一个插件。
2. `docs/architecture.md` + 本手册第 3 章——建立组合/循环/事件三张地图。
3. `packages/core/scope/src/`（最短）→ `session/src/` → `system-prompt/src/` → `tools/src/` → `agent/src/` → `agent-loop/src/`——按依赖方向读主干（第 5 章）。
4. 沿一次 turn 走读 `agent-loop/src/agent.ts` 的 `turn()`/`step()`（第 6 章）。
5. 读一个完整 seam：`packages/shell/{shell,bash-local,tool-bash}/src/`（第 9 章），再读 `subprocess`/`sandbox`/`fs`（第 10 章）。
6. 读一个 event-sourced 状态域：`packages/goal/goal/src/`（第 13 章 goal）。
7. 读一个编排域：`packages/subagent/subagent/src/` 与 `packages/workflow/workflow/src/`。

## 十个动手练习（难度递增）

1. **加一个 echo 工具**：用 `defineTool` 注册 `echo`，跑通「注册 → 进 prompt → 执行 → `tool/result`」。
2. **改一个提示词片段**：注册 `PromptSection`，验证它进入 `request/header`。
3. **写一个 pre-step 监听器**：观察/改写进入步骤的消息，验证 `PreStepDecision` 的 enter/reject。
4. **加一个 `SessionEventMap` 事件**：声明合并新类型 + `session.append` + 写 invariant 断言它。
5. **读日志派生**：对一个会话调 `deriveMessages()`，用 `foldRequestHeader`/`foldSurface` 重建 header 与 surface。
6. **换一个 provider**：把 `ctx.shell` 换成 `bash-sandbox`，观察 argv 如何被 `confine` 包装。
7. **跑一次 compaction**：触发 `compaction-basic`，读日志里的 `compaction/*` 事件与那条 `surfaceOp: replace`。
8. **玩 fork/lineage**：`ctx.sessions.fork` 一个子会话，看 `parentSession`/`seedLength`/`session/end-seed`。
9. **写一个子代理 provider**：实现 `SubagentProvider` 注册到 `ctx.subagents`，用 `tool-subagent` 委派一次。
10. **跑一个快照测试**：参考第 15 章，给一个可运行 example 加无密钥快照场景。

## 自检清单

能答出这些问题，就算出师：

- 「一切都是插件」在架构上如何成立？循环为什么可替换？
- 一个能力 seam 三角色各自是什么？举 `dsh-shell` 为例说清 `resolve(request): Spec`。
- 「模型可见 ⟺ 已入日志」这条不变式落实在哪几处？新模型可见输入要改什么？
- 三层事件的语义边界是什么？waterfall 与 serial 的区别？
- `SessionEventMap → SessionEvent` 的类型机制？`surfaceOp: replace` 何时发生？
- swap 一个 `ctx.subprocess`/`ctx.fs` provider 为什么能移动 Bash/PTY/LSP？
- subagent 的 continuable child / Activation 是什么？goal 的 activation 为什么进程内不持久？
- 为什么 `interrupted` 是唯一不循环发出的 `TurnEndReason`？崩溃恢复怎么配平？
- 每包 invariant 断言的「关系」而非「形状」，举例说明。

## 深挖索引（想看更多时去哪）

- **为什么**：`.agents/notes/implemented/architecture/`（设计决策一手记录）。
- **每个子系统**：`docs/subsystems/*.md`（类型 + 生成的 Cordis API）。
- **每个事件**：`docs/event-producer-consumer.md`（生产方/消费方矩阵，程序生成）。
- **每个工具 schema**：`docs/tool-catalog.md`。
- **模块依赖**：`docs/module-graph.md`（`pnpm run gen-module-graph`）。
- **工程约定**：根 `AGENTS.md` + `packages/AGENTS.md` + `docs/AGENTS.md`。

## 收尾

这套手册到此结束。它的定位是**导读 + 地图**：把官方文档组织成路线、指出「为什么」与「源码在哪」，而真正的精通来自你在第 5～13 章指出的源码里反复走读、并亲手完成上面十个练习。遇到「这是不是该写进文档」的判断，回到 [`docs/AGENTS.md`](../docs/AGENTS.md) 的分层与「一个事实一个家」原则。