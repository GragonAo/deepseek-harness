# 第 13 章 · 能力全景目录

> 阶段：精通。把第 9 章 seam 表之外的其余包按主题速览一遍。每段标注「是否 seam + 角色 + 关键类型 + 一处设计要点」。细节见各包子系统页（[`docs/subsystems/README.md`](../docs/subsystems/README.md)）与各包 README。

## A. 模型面向工具与能力 seam

### skill（完整 seam）
Definition `dsh-skill`（`SkillRegistry`，`ctx.skills`）；Provider `skill-filesystem`（本地发现）、`skill-badge`；Consumer `tool-skill`（catalog + 模型侧 loader）。要点：`registerProvider` / `register` / `list` / `get` / `snapshot`；`renderSkillContent()` 是唯一 canonical `<skill_content>` 渲染。registry 是 host+per-scope 分层（近层遮蔽远层，同层按 `rank` 决胜负）。invocation policy 用两个独立布尔拆出「模型可调用 / 用户可调用」四面。

### web（完整 seam）
`WebRuntime`（`ctx.web`）注册 search/fetch provider；Consumer `tool-web`（`web_fetch`/`web_search`）。要点：`WebError` 继承 `HarnessError`；packages/web/AGENTS.md 强制「带凭据请求拒绝跟随重定向」防凭据转发。

### terminal（完整 seam）
`TerminalSessionService`（`ctx.terminals`）+ `terminal-bash` + `tool-terminal`（六个工具）。owner-scoped 持久 PTY；`kill()`/disposal 等进程树 quiescent。互补 one-shot bash/fs。

### lsp（完整 seam）
`LspService`（`ctx.lsp`）+ `lsp-stdio` + `tool-lsp`。恰好四个语义操作，**无通用 JSON-RPC 逃生舱**；扩展名所有权排他。

### code-runtime（完整 seam）
`CodeRuntime`（`ctx.codeRuntime`）+ `code-runtime-worker-thread` + Consumer 是 `dsh-tools` 的 **Code Mode**（`run_code` 工具）。`run(request)`：所有程序结局都经 `error` 字段 resolve，从不 reject；`isolation` 是标签非安全声明；worker 后端每次全新 worker + host 侧 type-strip + 双预算（computeMs/maxWallMs）。

### jobs（完整 seam）
`JobRegistry`（`ctx.jobs`）+ `jobs-local` + `tool-jobs`（`job_*` 控制）。`start` 原子注册返回 `<kind>-N` id；settlement first-wins；**完成通知最后宣告**（先 commit 再通知）。

## B. 编排、委派与延续

### subagent（完整 seam，重点）
`SubagentRuntime`（`ctx.subagents`）+ 六个 provider（spawn/fork-in-process、acp、codex、claude-code、dsh-sdk）+ 共享 `subagent-in-process-driver`。Consumer：`tool-subagent`（委派）、`tool-subagent-control`（`send_message`/`list_agents`）、`tool-subagent-report`。

设计要点：

- **provider 多样化**：多命名 provider 并存（镜像 `LlmRuntime.registerAdapter`，与 bash 单 executor 相反）。
- **continuable child + Activation**：child 有持久 Session + 最多一个进程内 Activation（residency epoch）；inbox 是唯一 FIFO，continuation manager 拥有 residency，agent loop 拥有 turn 排程；冷恢复只凭折叠的 descriptor。
- **委派策略继承**：in-process child 在委派边界固定权限——快照父 sandbox override、approval 钉 `never`、注入 `subagent:delegation` 上下文；权限不可扩张，超出如实报告。
- **settlement 通知**：child settle 时父先收到一条 user-role 通知（含 stop reason + 最终输出），**在释放所有权之前**发。

### workflow（完整 seam，重点）
`WorkflowEngine`（`ctx.workflowEngine`，抽象）+ `workflow-worker-thread` + `tool-workflow`（通用）/ `tool-ralph`（固定 Ralph 循环）。脚本 hooks：`agent` / `pipeline` / `parallel` / `phase` / `log` / `args`。

设计要点：

- **错误纪律**：误用 hook **总是杀死脚本**（fatal），普通 child 失败才把 `agent()` 解析为 `null`；`result` 永不 reject（失败→`stopReason:'error'`，取消→`'cancelled'`）。
- **引擎**：每次 run 全新 worker vm；`realm.ts` 把返回值物化为纯 JSON；worker 隔离是 containment 非安全边界。
- **ralph**：每轮全新 child（拒绝 `inheritsParentContext` 或缺 `outputSchema` 的 provider），只传 immutable objective + 上轮 bounded handoff；四态终局。

### schedule（状态域 + 工具）
版本化 `schedule/change` 流 + fold 派生 active 记录 + create/list/delete 工具。不暴露公共 service；fork 只从 `seedLength` 之后派生；到期提醒进普通 followup 队列。

### goal（重点，详见下文 D 组）

## C. 状态域：event-sourced 到 session log

### todo
`todo_write(todos)` 工具，**每次整表替换**（无部分更新、无 id），status 三态；每次调用 append 一个 `todo/write`（last-write-wins 重放）。可选注册 `todos` projection unit。

### plan
`PlanModeController`（`ctx.planMode`）。`plan/mode {active}` 是 log-only 整值事件，`foldPlanMode` 从日志恢复。`get/set`；open turn 中 `set` 挂起 pending 等下一个被接受的 in-turn pre-step 落盘。`exit_plan_mode` 工具始终注册（保 catalog 稳定）。**软引导**：sandbox/approval 独立强制，互不读写 plan 状态；exit 走 `ctx.userQuestions` 的 `plan-review` intent。

### goal（重点）
`GoalService`（`ctx.goals`，extends `TypertRemoteService`）+ `tool-goal` + `command-goal` + `goal-round-driver`。设计要点：

- **phase/revision 事件溯源**：所有变更 append `goal/change`（post-mutation 快照），session log 是唯一权威；`GoalRef {id, revision}` 是 compare-and-set 栅栏（stale rev 抛 `GOAL_STALE_REVISION`）。
- **activation 进程内不持久**：`armed/disarmed` 不参与回放，每次 `agent/session-start` 都 disarm；resume/fork 保留 objective/phase/revision 但不自动开工。
- Goal Round 是「由目标触发的 turn」；`roundsStarted` 只在被 admit 的 goal 来源 user/message 上递增，普通人类 turn 不计。

### feedback
`command-feedback`（`/feedback`，log-only，绝不进模型上下文）+ `message-feedback`（`TypertRemoteService`，storage sidecar，不进 Session 事件/投影/telemetry）。

### preset
`AgentPresets`（`ctx.agentPresets`）+ `persona`。preset = 目录 + `agent.cordis.yml`；standing mount 挂一次，命名 session 经 scope 父链（agent→preset→global）join。`mount()` 唯一受支持调用点是 agent factory 的 `setup(agentCtx)`；child 用 `composeFrom`（同步 bind 父 preset 一代）。`recompose` 只允许 blank session（避免新工具集无法重放旧 tool call）；authoring copy-only。

## D. 循环卫生与元能力

### guard（自包含消费者，非 seam）
- `repeat-tool-reminder`：按 `(tool, 规范化参数)` 统计连续相同调用，阈值 `[3,5,8]` 注入升级提醒；per-agent `WeakMap` 计数，compaction 不重置。
- `timeout-policy`：单一 `tools/execute` around-dispatch 监听器，给声明了 `timeoutMs` 的工具武装协作 deadline（`TOOL_TIMEOUT`），**协作而非硬杀**。

### compaction（完整 seam，重点）
`CompactionEngine`（`ctx.compaction`，抽象）+ `compaction-basic` + `command-compact`。三操作 `compactIfNeeded`（pressure/context-overflow）/`compactNow`/`compactRegion`。

- 成功压缩 = 摘要 → `compaction/summary` 事件 → **唯一 surface 变更**（一个 `surfaceOp:{replace}` 的摘要 checkpoint）→ 释放 lock。
- **lock 是耐用括号**（有 `compaction/start` 无 `compaction/end` 即 `busy`），崩溃不留假完成。
- 事件 `compaction/start→summary→end` 经声明合并扩展 `SessionEventMap`（log-only）。
- Definition 有意依赖 `dsh-session` + `dsh-llm`（动词在 Session 上，输出是 ContentBlock）。

### extensions（runtime 自修改，重点）
`tool-cordis`（五个模型工具 `cordis_inspect/define/run/stop/undefine`）+ `cordis-host-runner`（`node:vm` 沙箱 + fiber 生命周期）+ 浏览器半 `cordis-client-runner` + `ui-cordis`。

- 动态包只活内存，不产生 Plugin 文件、不改 cordis.yml、重启即失、不可自动提升；每个动词 session-scoped。
- **vm 沙箱是隔离非安全边界**（信任姿态等同 bash）。

### hooks
`hook-protocol`（库，非 cordis 插件）+ `hooks-claude-code` / `hooks-codex`（桥）。把外部 shell-hook 协议翻译到 harness 自己的 typed 拦截扩展点（`agent/pre-step`、`tools/pre-execute` 等）。Core 只放两方言真正相同的部分；`hook/invoked`/`hook/result` log-only 事件经 `handlerId` 关联。

### context
`agent-instructions`（加载 AGENTS.md 兼容指令，注入 durable `<system-reminder>`；用结构化 `ctx.fs` 工具发现而非 shell `cd`）、`session-reference`、`time-context`、`tmux-context`。纯 product 插件注入模型可见上下文，不加工具。

## E. 人机协作平面（`packages/interaction/`）

- `commands`（`ctx.commands`）：人类斜杠命令注册表；每条命令记 log-only `command/run`/`command/done` 对；结果不进 model history。
- `user-approval`（`ctx.approval`）：channel-neutral 一次性审批；`approval/request` waterfall 找 answerer；缺 answerer fail-closed。
- `permission-presets`（`ctx.permissionPresets`）：把 `sandbox/mode` + `approval/policy` 打包成命名 preset（`workspace-write`/`danger-full-access`）。
- `user-questions`（`ctx.userQuestions`）：`ask(request)`，每 context 仅一个 provider；`Intent` 带标签（如 `plan-review`）让 UI 呈现为评审决策。
- `tool-ask-user`（`ask_user_question` 工具）：user-questions seam 的 Consumer，只映射模型参数并回传答案。

## F. 基础设施 seam 与身份

- `settings`（完整 seam）：`SettingsService`（`ctx.settings`）+ `settings-file`。命名空间 schema 注册 + 分层解析（schema 默认 → 组合 base → 用户文档）；`revision` + `expectedRevision` 冲突检测（`SETTINGS_CONFLICT`）。
- `credentials`（完整 seam）：`CredentialService`（`ctx.credentials`）+ `credentials-local`（env-over-.env）。配置携带**引用而非秘密**；`resolve` **每操作解析**，轮换后下次请求即生效；read-only 源 shadow 时 `set/unset` fail-loud。
- `identity`：`dsh-anonymous-user-id`（库）。harness-home 作用域随机 UUID，绝不由 hostname/网络/git remote 派生；删除即重置。
- `e2b`（POC）：`ctx.e2b`（沙箱生命周期）+ `fs-e2b` + `subprocess-e2b`。provider-composition POC——把 filesystem/进程执行世界放进 E2B Linux 沙箱（第 10 章）。

## 组织的底层规律

这些包都围绕两条主轴：**「capability seam = Definition + Provider + Consumer」**（可替换能力），和**「event-sourced 到 session log 的状态域 + 消费者」**（goal/plan/todo/schedule/feedback/preset）。guard/extensions/hooks/context/identity/e2b 是各自独立的问题域，它们或实现 seam、或作为自包含消费者挂在 `Agent`/`Session`/`tools`/扩展点上，**从不改 `agent-loop`**。

下一章把所有这些机制落到「我要自己加一个能力」的实操。