# Agent Note: One owner for the sandbox DSH_* environment

Status: implemented

[English](2026-10-08-one-owner-for-sandbox-dsh-environment.md) | 中文

## Problem

两条执行入口进入同一个租户沙箱时，拿到的受管 `DSH_*` 环境不一致。在试用部署上观测（`trial-tenant` / `trial-user`，会话 `session-9b5e8389-1176-42f1-b555-123dadcfe4d2`）：`bash` 工具看到 `DSH_CASE_ID`、`DSH_HOME=/root/.dsh`、`DSH_SESSION_ID=session-9b5e8389-…`、`DSH_SHELL=1`、`DSH_TENANT_ID`、`DSH_TOOL_EXEC_IDLE_MS=900000`、`DSH_USER_ID`；而 `run_code` 程序看到同样的沙箱身份三件套与空闲预算，却是 `DSH_SESSION_ID=undefined`，没有 `DSH_HOME`，没有 `DSH_SHELL`，`cwd=/opt/tool-exec`。

两个层次解释了这种分裂。沙箱自身的环境在容器启动时就固定了——`container-docker` 传 `-e DSH_CASE_ID/DSH_TENANT_ID/DSH_USER_ID` 与空闲预算，`container-k8s` 在 Pod 上设同一组名字——而容器内的 tool-exec 服务把它自己的进程环境合并进每次 exec，因此两条路径本来就继承到这些事实。真正不同的是每次执行的 harness 事实：只有 shell 路径组装过它们，路径是 `ctx.shellEnv.collect(execution)` → `ShellExecRequest.dshEnv` → `dsh-bash-local` 合并进 spawn spec。容器代码运行时只组装了 `DSH_CODE_BRIDGE`，而它所在的层次也够不到别的东西：`CodeRunRequest` 只带程序、binding 与信号，且 [`dsh-code-runtime`](../../../../packages/code-runtime/code-runtime/README.md) 明确写着运行时不知道工具与会话。`packages/tenant/*` 里也没有任何地方组装过 harness 变量组——`dsh-subprocess-container` 只透传 `spec.env`——所以在 `packages/tenant/*` 里存在的，只有 `container-docker` 与 `container-k8s` 各自拼的那份沙箱作用域重复列表。

会话事实不能挪进沙箱自身的环境来补这个缺口。沙箱按 (tenant, subject) 缓存并带 `sandboxCacheTtlMs`，服务该 subject 的任何一个会话，因此放在那里的会话 id 对该 subject 除一个会话之外全都是错的。

## Decision

[`@deepseek-ai/dsh-shell-env`](../../../../packages/shell/shell-env/README.md) 里的 `composeDshEnvironment(facts: { dshHome, sessionId? })` 是唯一给这些内置键点名的地方，`ctx.shellEnv` 通过两个入口交出同一个变量组：

- `collect(execution)` 为一次 shell 工具调用渲染它——行为不变：会话取 `execution.agent.session.header.id`，contributor 变量叠加其上。
- `collectSession()` 为注册表手里没有 `ToolExecution` 的 harness 进程渲染它。只含内置变量，会话取自 `ctx.get('agents')?.currentInitiator()?.session.header.id`——即 agent loop 通过 `agents.withInitiator()` 为当前驱动链建立的 ambient 权威。进程环境永远不是来源：initiator 边界之外该变量缺席，注册表已释放时 `currentInitiator()` 抛错也只是让该变量缺席，而不是让调用方的运行失败。

[`dsh-code-runtime-container`](../../../../packages/code-runtime/code-runtime-container/README.md) 用 `ctx.get('shellEnv')` 调 `collectSession()`，并把结果与 `DSH_CODE_BRIDGE` 一起合并进它的 exec 环境。它通过 `ctx.get` 而不是声明式注入读注册表，因此没有挂载 shell-env 的组合就干脆不注入受管变量组，运行时也不会自己维护一份可能漂移的变量列表。`dsh-subprocess-container` 仍是承运方：调用方的 `spec.env` 原样到达容器 exec。

## Alternatives considered

- **给 `CodeRunRequest` 加 `dshEnv` 字段**，由跑程序的那个消费方填：拒绝——它把 harness 环境词汇塞进代码执行接缝，要求每个运行时与消费方都携带它，而且仍会让 `ctx.codeRuntime` 的其他调用方拿不到这组变量，于是规则落在消费方而不是做出决定的那个操作里。
- **在 `dsh-subprocess-container`（租户进程 provider）里组装**：拒绝——subprocess provider 的职责是透传调用方的 spec，它没有 `ToolExecution`，每次 spawn 都得去问 ambient 作用域，而且在那里合并可能顶掉消费方有意设置的 `DSH_*`（`dsh-terminal-bash` 自己组装 `DSH_SHELL`、`DSH_SESSION_ID`、`DSH_PTY_SESSION_ID`）。
- **在 `@deepseek-ai/dsh-container` 或 `@deepseek-ai/dsh-subprocess` 里组装**：拒绝——这两层位于 harness 之下，不知道会话，也无法解析 Harness 主目录；它们要么复制这些事实，要么自己长出一份配置。
- **由沙箱 provider（`container-docker`、`container-k8s` 的 `sandboxEnv`）注入该变量组**：拒绝——沙箱比会话活得久，并被同一 subject 的多个会话共用，放在那里的会话作用域取值对除一个之外的所有会话都是错的，放在那里的主目录取值也会成为注册表之外的第二个来源。
- **给容器代码运行时自己的 `dshHome` 配置加默认值**：拒绝——主目录取值出现第二个所有者，而注册表已经从 `dshHome`/`$DSH_HOME`/`~/.dsh` 解析它。

## Consequences

- 两条入口注入同一份内置变量组。`bash` 额外收到沙箱自身的身份变量、它自己的消费方环境（`NO_COLOR`、`TERM`、`PAGER`、`GIT_PAGER`）以及 contributor 变量；`run_code` 程序收到沙箱身份变量、受管变量组与桥接 URL。
- contributor 变量仍然只到 shell。contributor 从 `ToolExecution` 解析，而 `DSH_SESSION_JSONL` 还需要会话头去调 `sessionPersistence.locate()`，因此 `collectSession()` 只组装内置变量，`run_code` 程序永远收不到它们。两个包都把这一点记进「已知限制」。
- `DSH_SESSION_ID` 只在 agent 驱动链内到达程序——模型发起的 `run_code` 调用正是这种情况。宿主机层或自动化在没有 initiator 边界时调 `ctx.codeRuntime.run`，拿到主目录与 shell 身份但没有会话，是缺席而不是猜出来的值。
- 程序的进程从此携带它此前没有的 harness 事实。它们是该沙箱自身的部署与会话事实，同一沙箱里任何 `bash` 调用本来就读得到；受管命名空间是关联约定而不是凭据，`DSH_SESSION_JSONL` 是位置提示。
- [`dsh-shell-env`](../../../../packages/shell/shell-env/README.md) 为这次 ambient 读取增加对 `@deepseek-ai/dsh-agent` 的 peer 依赖；[`dsh-code-runtime-container`](../../../../packages/code-runtime/code-runtime-container/README.md) 增加对 `@deepseek-ai/dsh-shell-env` 的 peer 依赖。
- shell 路径的会话身份规则归[会话身份与日志位置 Agent Note](../feature/2026-07-10-agent-session-identity-and-log-location.md)所有，该篇保持有效，并已就地链接到本篇以说明第二个入口。
- 持久终端路径仍在这份所有权之外：[`dsh-terminal-bash`](../../../../packages/terminal/terminal-bash/README.md) 自己组装 `DSH_SHELL=1` 与 `DSH_SESSION_ID`（取自 spawn spec 的 owner），也不设 `DSH_HOME`。把它并进来需要一个接收显式 agent 的注册表入口，因为 PTY spawn 不一定位于其 owner 的 initiator 链内，而 `collectSession()` 只读 ambient 作用域。

### Verification

- `packages/shell/shell-env/tests/shell-env.spec.ts` 钉住唯一所有者：同一批 facts 下 `composeDshEnvironment(facts)` 等于 `collect(execution)` 渲染出的内置变量；没有会话时省略 `DSH_SESSION_ID`；`collectSession()` 在替身 ambient initiator 下等于它，在没有 agent 服务、没有 initiator 或 ambient 读取抛错时省略该变量，并且在 `collect()` 带着 `DSH_SESSION_JSONL` 的同时不包含任何 contributor 变量。19/19 通过。
- `packages/code-runtime/code-runtime-container/tests/runtime.spec.ts` 在真实注册表下运行一个返回 `process.env.DSH_HOME` 的程序：程序读到解析后的主目录，记录的 exec 环境恰好是 `composeDshEnvironment(facts)` 加上 `DSH_CODE_BRIDGE`，而没有 shell-env 的组合里只剩桥接 URL。9/9 通过。
- `packages/tenant/subprocess-container/tests/container.spec.ts` 钉住承运行为：`env` 为 `composeDshEnvironment(...)` 的 spawn spec 原样到达 `containerRuntime.exec`。6/6 通过。
- `pnpm exec tsc -b tsconfig.host.json` 干净。
- `pnpm run verify-export-jsdoc`、`verify-agent-note-format`（612 篇）、`verify-agent-note-classification`、`verify-package-readme-limitations`（252 个 README）以及本次改动涉及的四个中英对的 `verify-translation-pairing` 全部通过。
- 直接钉住 `collect()` 的两个套件——`dsh-tool-bash` 与 `dsh-bash-local`——被 `vitest.config.ts` 在 Windows 上排除（它们需要真实的 POSIX shell），因此没有在宿主机上跑。同一注册表的 pwsh 消费方跑了：`packages/shell/tool-pwsh` 通过 61 个单元、6 个集成、1 个 loader 测试，另有 20 个 `tool-pwsh-persistent` 与 18 个 `tool-bash-persistent` 测试。
- 未在此验证：租户栈的真实组合。租户 spine 同时挂载 `shell-env` 与 `code-runtime-container`，所以两条路径解析到同一个注册表，沙箱 provider 注入的也是试用部署上看到的身份三件套——但要钉住组装后的租户部署需要集群，而本次改动不碰集群。
