# 第 10 章 · 单一执行世界

> 阶段：精通。文件系统与进程执行共享**同一个执行世界**——这是「换一个 provider 就换掉整个产品」在执行层的证明。参考：[`docs/subsystems/subprocess.md`](../docs/subsystems/subprocess.md)、[`docs/subsystems/sandbox.md`](../docs/subsystems/sandbox.md)、[`docs/subsystems/filesystem.md`](../docs/subsystems/filesystem.md)、[`docs/subsystems/terminal.md`](../docs/subsystems/terminal.md)、[`docs/subsystems/lsp.md`](../docs/subsystems/lsp.md)。

## 三个 seam 的关系

```
ctx.subprocess（进程坐标、进程树/会话生命周期、stdio、kill 升级）
   ↑ 被消费
bash-local / terminal-bash / lsp-stdio（都经 ctx.subprocess spawn）
   ↑ 也各自读
ctx.sandbox（把即将 spawn 的 argv 包装成受限 argv）
ctx.fs（文件读写，与 subprocess 共享执行世界）
```

## `ctx.subprocess`：进程执行 seam

`subprocess`（Definition，`subprocess/src/index.ts:102` 的 `SubprocessRuntime`）+ `subprocess-local`（Provider）抽象了四件事：

1. **进程坐标**：`resolveExecutable` / `spawn` / `spawnTerminal`；`SubprocessSpawnSpec` **零默认**（完全显式）。
2. **进程树 / 会话生命周期**：跟踪后代、成组 kill；`SubprocessHandle.terminate()` 是**唯一终止动词**（SIGTERM → 宽限 → SIGKILL；POSIX 进程组 / Windows `taskkill /T`）。
3. **stdio 处置**：管道 / PTY / spill 大输出；local 的 `spawnSubprocess`（`subprocess-local/src/spawn.ts:326`）用 `detached: platform !== 'win32'` + `OutputCollector` tail-keep/spill。
4. **kill 升级**：`SubprocessOutcome` **不含分类**（`timedOut`、`signal`、`exitCode` 各自独立上报——第 4 章「正交结果独立上报」）。

三个 Consumer 的三种 stdio 形态：`bash-local`（collect 型 batch）、`terminal-bash`（`spawnTerminal` 持久 PTY 会话）、`lsp-stdio`（stdin/stdout `'pipe'`、stderr collect 但不 spill，`lsp-stdio/connection.ts:92`）。

## `ctx.sandbox`：进程限制 seam

`SandboxProvider`（`sandbox/src/index.ts:158`）只有一个方法 `confine(argv, policy): ConfinedArgv`——接收**即将 spawn 的确切 argv**，按每次调用策略包装它并报告强制执行情况（[`docs/architecture.md`](../docs/architecture.md#where-new-behavior-goes)「Confine spawned processes」）。`LocalSandboxProvider.confine`（`sandbox-local` 316 行）返回 `[...runnerArgv, '--', ...argv]`，runner 链 `PLATFORM_CHAINS`（bwrap / landlock / seatbelt / windows-acl），fail-closed 为 `SANDBOX_UNAVAILABLE`。

`sandbox-policy` 的 `SandboxPolicyService.resolve` 按优先级求和：显式批准模式 > 会话 `sandbox/mode` 事件 > 部署默认；它与 `writableRoots`（`sandbox/src/roots.ts:52`）共同保证 **bash 与 fs 不会限制到不同的根目录**。

## `ctx.fs`：文件系统 seam

`FileSystem`（`fs/src/index.ts:86`，`ctx.fs`）定义 `resolve` / `processPath` / `readText` / `writeText` / `editText`，以及 `FsTarget`、读/写/编辑结果、观测状态、`FsErrorCode`。Provider 差异：

| Provider | 差异 |
|---|---|
| `fs-local` | realpath `targetKey` + `withLock` 串行化 + 原子写/编辑 |
| `fs-sandbox` | `checkedTarget` in-process fence，越界抛 `FS_SANDBOX_DENIED`（`containment.ts` 的 `isPathUnder`）；限制**变更**，读仍可 |
| `fs-e2b` | E2B 远程 Filesystem API |

`fs-observation-policy` **不注册服务**，纯用 `fs/write-intent`/`fs/edit-intent`（单槽 waterfall，策略监听器**不调 `next()`**）+ `fs/observed`（emit）做门禁，状态是 `WeakMap<owner, Map<targetKey, FsObservation>>`——即第 7 章的「先读后编辑」检查。`tool-fs`（inject `['tools','fs','systemPrompt']`）execute 顺序：`resolve` → waterfall 取 intent → `ctx.fs.writeText/editText` → emit `fs/observed`。

## 证明：单一执行世界

三处重证：

1. **类型互指**：`FileSystem.processPath` 的语义是「a subprocess in this filesystem's execution world can open」，`SubprocessRuntime` 自述「one execution world shared with the mounted filesystem provider」；`DshEnvironment`/`CollectedOutput` 归 `subprocess` 所有、由 `shell` 重导出。
2. **四个 Consumer 一行不改**：`bash-local`/`terminal-bash`/`lsp-stdio`/`tool-fs` 都把执行世界操作委派给 `ctx.fs` + `ctx.subprocess`，从不直接 touch 进程/文件；因此一次 provider 替换（`bash-local`→`bash-sandbox`、`fs-local`→`fs-sandbox`）就整体换掉执行坐标。
3. **`packages/e2b`** 证明可移植性：只挂 `fs-e2b` + `subprocess-e2b` 两个 adapter，`bash-local`、`terminal-bash`、`lsp-stdio` 的可变工作就整体进入同一个远程 Linux 沙箱，**无需 E2B 专属 fork**。这不移动 harness 进程、Cordis 对象、模型调用或 session 状态（boundary 见可移植执行世界 Agent Note）。

## 为什么这很重要

它意味着**一致性是免费获得的**：沙箱模式、写限制、根目录限制只在底层三个 seam 上各实现一次，所有上层能力（Bash、PTY、LSP、未来任何经 `ctx.subprocess`/`ctx.fs` 的能力）自动共享同一套限制，不会出现「bash 能写但 fs 工具不能写」的分裂。

## 补充：terminal 与 LSP

- **terminal**（`ctx.terminals` + `terminal-bash` + `tool-terminal`）：owner-scoped 的持久 PTY 会话，跨多次工具调用存活；`kill()`/disposal 等后端捕获的进程树 quiescent。互补 one-shot bash/fs，而非取代它们更强的 per-operation 契约。
- **LSP**（`ctx.lsp` + `lsp-stdio` + `tool-lsp`）：恰好四个语义操作（`goToDefinition`/`findReferences`/`goToImplementation`/`hover`），**无通用 JSON-RPC 逃生舱**；一个 runtime 内扩展名所有权排他。

下一章离开执行层，看 LLM 与远程网关这条「类型安全」链。