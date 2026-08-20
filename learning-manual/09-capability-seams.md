# 第 9 章 · 能力 seam 三件套

> 阶段：精通。这是 dsh 最核心的组织原则：**可替换能力 = Service Definition + Service Provider + Consumer**。参考：[`docs/capability-seams.md`](../docs/capability-seams.md)、[`docs/glossary.md`](../docs/glossary.md#capability-seam)。

## 术语钉死

- **seam** = 三角色的完整能力，绝不是其中一个角色。
- **Service Definition**：拥有自己 `ctx.<key>` 和词汇类型的 Cordis `Service`——可以是抽象类（如 `ShellExecutor`），也可以是具体注册表（如 `WebRuntime`），**绝不是 TypeScript `interface`**。
- **Service Provider**：实现 Definition 的一方。
- **Consumer**：注入并使用该服务的插件（通常是面向模型的工具）。

角色需要各自独立演进时放在不同包；属于同一关注点时一个包可以合多角色（`dsh-llm` 同时是 Definition 和 Consumer）。

## 规范范例：`dsh-shell`

`packages/shell` 是 seam 的教科书（[`docs/glossary.md`](../docs/glossary.md)）：

| 角色 | 包 | 关键点 |
|---|---|---|
| Definition | `dsh-shell` | 抽象类 `ShellExecutor`，声明 `ctx.shell` |
| Provider | `dsh-bash-local` / `dsh-bash-sandbox` / `dsh-pwsh-local` | 实现执行器 |
| Consumer | `dsh-tool-bash` / `dsh-tool-pwsh` | 面向模型的 bash 工具 |

设计核心是**「显式 > 隐式」的请求/spec 拆分**（[`docs/subsystems/shell.md`](../docs/subsystems/shell.md)）：

```ts
// Definition 只固定「两个阶段」的形态（shell/src/index.ts:65，super(ctx,'shell') + declare module 声明 ctx.shell）
abstract class ShellExecutor extends Service {
  resolve(request: ShellExecRequest): ShellExecSpec   // Request 可选 → Spec 必填
  run(spec): Promise<ShellRunResult>
  start(spec): ShellProcess                             // 后台进程句柄
}
```

「默认值从哪来」成为 `resolve(request): Spec` 里**可寻址、可替换、可测试**的一步，绝不藏在 `run()` 的 `?? default` 里。这正是根 [`AGENTS.md`](../AGENTS.md#conventions) 里「显式 > 隐式在包边界」的落地。

两个 Provider 展示这条拆分的两种落点：

- `LocalBashExecutor`（`bash-local/src/index.ts:102`，inject `['subprocess']`）：`resolve()`（146 行）用 `clampTimeout` 显式补全 `workdir`/`timeoutMs`/`stdoutMaxBytes`。
- `SandboxBashExecutor`（`bash-sandbox/src/index.ts:44`，inject `['subprocess','sandbox','sandboxPolicy']`）：`resolve` 补 `sandboxPolicy`，`run` 里 `confine()` → `runArgv(spec, confined.argv)`。

Consumer `tool-bash`（`tool-bash/src/index.ts`）只做 `ctx.shell.resolve(request)` → `ctx.shell.run/start(...)`，**绝不 import 具体执行器类**——这就是「换 provider 不改 Consumer」在代码上的证明。

## 为什么一个 provider 替换能换掉整个产品

**因为同一个 seam 被多个 Consumer 共享，且多个 seam 共享一个底层世界。**（[`docs/architecture.md`](../docs/architecture.md#capability-seams)）

- 把 `ctx.subprocess` 指向远程沙箱时，`bash-local`、`terminal-bash`、`lsp-stdio`（都通过 `ctx.subprocess` spawn）一起跟着走，无 provider fork。
- 把 `ctx.fs` + `ctx.subprocess` 都挂上 E2B adapter，则 bash/PTY/LSP 的**可变工作**整体进入同一远程 Linux 沙箱——这是 `packages/e2b` 演示的**可移植执行世界**（第 10 章）。

## 全仓库 seam 速览

完整图与依赖边见 [`docs/capability-seams.md`](../docs/capability-seams.md)（自动生成）。核心 seam 一览（Definition → Provider → Consumer）：

| seam | `ctx` key | Provider（例） | Consumer（例） |
|---|---|---|---|
| LLM | `ctx.llm` | llm-deepseek, llm-pi-ai, llm-replay | agent-loop, compaction-basic |
| 子进程 | `ctx.subprocess` | subprocess-local, subprocess-e2b | bash-local, terminal-bash, lsp-stdio |
| Shell | `ctx.shell` | bash-local, bash-sandbox, pwsh-local | tool-bash, tool-pwsh, hook 桥 |
| 终端 | `ctx.terminals` | terminal-bash | tool-terminal |
| 沙箱 | `ctx.sandbox` | sandbox-local | bash-sandbox, terminal-bash |
| 文件系统 | `ctx.fs` | fs-local, fs-sandbox, fs-e2b | tool-fs |
| Web | `ctx.web` | web-search-*, web-fetch-http | tool-web |
| LSP | `ctx.lsp` | lsp-stdio, lsp-local | tool-lsp |
| Skill | `ctx.skills` | skill-filesystem, skill-badge | tool-skill |
| 子代理 | `ctx.subagents` | spawn/fork-in-process, acp, codex, claude-code, dsh-sdk | tool-subagent, tool-ralph |
| 工作流 | `ctx.workflowEngine` | workflow-worker-thread | tool-workflow, tool-ralph |
| Job | `ctx.jobs` | jobs-local | tool-jobs, tool-bash |
| 压缩 | `ctx.compaction` | compaction-basic | command-compact |
| 代码执行 | `ctx.codeRuntime` | code-runtime-worker-thread | tools 的 Code Mode |
| 持久化 | `ctx.sessionPersistence` | jsonl, sqlite | agent-loop, session-query |
| 存储 | `ctx.storage` | storage-json, storage-sqlite | storage-domain |
| 设置 | `ctx.settings` | settings-file | llm adapters, apiproxy |
| 凭据 | `ctx.credentials` | credentials-local | llm adapters, apiproxy |
| Spill | `ctx.spillStore` | spill-local | spill-policy |
| 遥测 | `ctx.sessionTelemetry` | session-telemetry-otel | （出进程） |

## 三条纪律

1. **完整，绝不单角色**：加能力 = 设计三件套（[`docs/architecture.md`](../docs/architecture.md#capability-seams)）。
2. **Service Definition 为所有当前 Consumer 设计**：工具 schema、Loader、UI、transport、provider 特有行为留在 Consumer/provider 里，别让一个 Consumer 绑架服务契约（[`packages/AGENTS.md`](../packages/AGENTS.md)）。
3. **Definition 通常只依赖 cordis**（例外：`compaction` 依赖 `dsh-session` + `dsh-llm`，因为其动词定义在 Session 上、输出是 `ContentBlock`）。

## 反模式提醒

- **一个公共 service 方法只有一个内部调用方**：改用私有能力闭包（`RunCodeBridgeOptions` 即此类）。
- **用 `ctx.get(name)` 取可选服务**，别用属性代理 `ctx.<name>`（拓扑敏感，[`packages/AGENTS.md`](../packages/AGENTS.md)）。

下一章深入「单一执行世界」，看 subprocess/sandbox/fs 三个 seam 怎么耦合成一个可整体替换的世界。