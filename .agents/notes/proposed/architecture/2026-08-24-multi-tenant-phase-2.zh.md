# Agent Note：多租户第二阶段——完整对等与 ip+host 容器工具执行

状态：proposed

[English](2026-08-24-multi-tenant-phase-2.md) | 中文

## 问题

[第一阶段](../../implemented/architecture/2026-08-24-multi-tenant-slice.md)交付的纵向切片端到端证明了隔离不变式，但它刻意做得薄：一个已注册的 HTTP 操作（`/v1/run`）直接跑 `mkdir`/`printf`/`append` 脚本而非真正的 agent 轮次，容器世界则用 `docker exec -i` 打到一个永不回收的 `tail -f /dev/null` 占位进程上。生产级多租户 DSH 必须补上第一阶段笔记明确推迟的四个缺口：

1. **对等**——多租户用户必须获得与单租户 headless agent **完全一致**的 agent 体验：相同的 agent-loop、会话/回放词汇、全部面向模型的工具（bash、fs、terminal、lsp、web、skills、subagent、workflow、todo），以及逐轮持久化的会话事件。当前 `tenant-demo` 一个都没触达。
2. **到容器世界的网络可达**——agent 后端必须通过 IP+host（主机发布地址）与每个租户的工具执行端通信，而不是通过 shell 调用 Docker CLI。只有这样 agent 平面才是无状态的，并在物理上与 Docker 守护进程解耦。
3. **懒加载、快速、无状态的容器**——租户容器只能在租户首次工具调用时启动、快速启动，并且自身不持有任何持久执行状态：工作空间与工具由挂载带入，其余一切都是临时的。
4. **无工具路径**——不需要工具的租户请求必须完全在 agent 平面完成，绝不触碰容器运行时。

## 方案

对 `packages/tenant/` 做两个相互独立又可组合的扩展：

### 无状态 agent 平面：完整对等的 HTTP 载体

用覆盖在**既有**单租户 HTTP 接口上的租户鉴权载体替换单操作 `TenantHttpApi`——即 [`@deepseek-ai/dsh-host-apiproxy`](../../../../packages/host/apiproxy/README.md)。单用户 DSH 的"全部逻辑"已经以 `ctx.apiProxy` → `toFetchHandler` 交付：`POST /api/<method>` 一元 RPC 覆盖 `session.create/prompt/history/list/fork/models/selectModel/rename/attachment/updateQueue/cancel`、`subagent.*`、`goal.*`、`settings.*`、`credentials.*`、`llm.*`、`workspace.*`、`skill`、`agent-preset.*`，外加 `GET /api/events.mux` SSE 帧复用流。因此 `packages/tenant/agent-http` 不再另造一个削减版 `session/prompt` 词汇，而是包裹这层接口：

- 一元 RPC——bearer JWT → 租户解析 → `runWithTenant(tenant, () => toFetchHandler(ctx.apiProxy).fetch(request))`；租户维度的 provider（`session-persistence-postgres`、`subprocess-container`、`fs-container`、`container-docker`）在该权威内通过 `requireTenant()` 解析。
- mux SSE——同一 `apiProxy.events.mux` 迭代器，逐帧重入 `runWithTenant`，使租户连接只回放它有权看到的帧。

该结点启动 Web GUI 组合的宿主服务栈（`packages/bundle/web-app` 宿主插件——settings、credentials、`llm-deepseek`、agent spine、session 持久化、compaction、projection、subagents、workflow、每一个面向模型的工具，以及 `apiproxy` 自身），用 provider 替换把整个本地执行与隔离世界搬进容器：`session-persistence-jsonl` → `session-persistence-postgres`、`subprocess`（`dsh-subprocess-local`）→ `subprocess-container`、`fs-sandbox` → `fs-container`、`bash-sandbox` → `bash-local`、`sandbox`（`dsh-sandbox-local`）→ 禁用。这些 sandbox 行并非附带项：Web shell 挂载的是沙箱包裹的变体——`bash-sandbox`（`SandboxBashExecutor` `static inject = ['subprocess','sandbox','sandboxPolicy']` 把本地 argv 经 `ctx.sandbox` 包裹）与 `fs-sandbox`（`SandboxedFileSystem` 继承 `LocalFileSystem`、注入 `sandboxPolicy`）——而非 headless 原型的裸 `bash-local`/`fs-local`，因此 `ctx.fs`/`ctx.subprocess` 与宿主机 landlock/seatbelt 执行器耦合。在租户组合中容器本身就是隔离边界：宿主机 `sandbox` 被移除，裸 `bash-local` 跑在容器 subprocess 上，`sandbox-policy` + `approval` 保留以解析工具层每次调用的 workspace-write 模式——钉在容器可容许的 `workspace-write` + `ask`，同时 `permission`（`dsh-permission-presets`）也被禁用，因为它的预设捆绑了 `danger-full-access` 模式并读取容器执行器不暴露的 `ctx.shell.sandboxMode`。超出最初三处的这七处禁用替换体现在 Loader 的 `cordis.yml` 中，并且已通过启动验证，因为这是 Web shell 执行世界与 http-parity spine 唯一不同的地方。agent 或会话状态都不驻留在 HTTP 进程中：`apiproxy` 已经通过 `ctx.agents.resume` 恢复冷会话，所以一个副本可以被杀掉，另一个副本对着同一个 Postgres 恢复。

权威传播已端到端实证（`tenant-demo/tests/agent-isolation.spec.ts`）：`AsyncLocalStorage` 租户会留存进 agent-loop 的工具执行 fiber——一段脚本化的 mock-LLM `bash` 调用能走到 `DockerContainerRuntime.exec` 内部的 `requireTenant()`，懒式 `docker run` 拉起 tool-exec 容器并经已发布回环端口路由命令；而“无工具”回合对容器运行时零调用。

载体链路也已于线上实证（`tenant-demo/tests/http-parity.spec.ts`）：经 `agent-http.fetch` 的 bearer-JWT `session.create` + `session.prompt` 进入真实 `ApiProxyService`/`toFetchHandler`，驱动真实 agent loop 执行脚本化 mock-LLM 的 `bash` 调用、进入租户容器（懒 `docker run`、一次 `/exec`）；无工具 prompt 零次容器运行时调用。无 agent-presets 名册时 `composeAgent` 会回退到共享主机组合，故网关无需 `agent-presets` 即可启动；集成是 `bundle/multi-tenant` profile bundle，把它作为 `['dsh-base','dsh-web-app','dsh-multi-tenant']` 经 Loader 启动现已密钥无关地实证（`tenant-demo/tests/multi-tenant-loader.spec.ts`）。

phase-1 切片 e2e 在目标服务器（`192.168.138.130`，真实 Docker + Postgres）上对刚构建的 `dsh-tool-exec:latest` 全 4/4 通过；该运行发现并修复了容器平面的冷启动序号竞争，现已包含有界就绪等待。完整对等 agent 回合 e2e 仍需由 Loader 的 `cordis.yml` 组合并在该服务器上运行。

跨会话可见性已限定并实证（`agent-http/tests/agent-http.spec.ts`）：`session.list`/`session.search` 条目与两条下行上的会话作用域帧（`events.mux`，以及 `events.host` 上的 `host/session-added|removed|status|agent-error` 与 `host/archived-sessions-changed`）被过滤到当前租户——另一租户持有的存活会话被丢弃，而冷会话（进程中无存活持有者、已由持久层绑定到该租户 schema）保持可见。持有者目录由该租户权威下观察到的 `session/created` 供给，因此无需给核心会话格式增加任何会话元数据。无会话 id 的主机平面帧（`host/workspace-*`、`remote-event` 允许清单）作为共享主机组合原样放行。

物理载体路由也已实现并实证（`agent-http/tests/agent-http.spec.ts`）：当存在 `webServer` 时，`AgentHttp` 通过自有的 node:http fetch 桥注册 `/api` 前缀路由，因此真实 `dsh web` 无需额外适配器即可经 HTTP 对外提供多租户 API——缺失凭证返回 401，有效 bearer 则在所解析租户内到达 `session.list`。这替换而非叠加 `client-connection` 的 DNS-rebinding 信任围栏，故二者不可在同一组合中同时挂载 `/api` 前缀。

租户记录现可在 cordis.yml 中声明（`TenantRegistry.Config.tenants`，一个 `z` schema：`{ id,name,dataRoot,workspaceRoot,toolsRoot?,enabled?,network? }`），于是集成在启动时注册其租户，而无需手写引导；每条记录以 effect 挂载并返回 disposer（已实证：HMR 释放会移除它，重复 id 以 `DUPLICATE_TENANT` 快速失败）。

五处 swap 现已是一个具体 profile bundle（`packages/bundle/multi-tenant`：`cordis.patch.yml` + 清单），并做了组合实证与启动实证。组合测试（`multi-tenant/tests/multi-tenant.spec.ts` 用与 boot include 相同的 `applyEntryPatches` 把它后置组合在 base + web-app 之上）断言零个跳过/名称不符的 patch、七行单用户行被禁用（六行本地行外加 `permission`）、`sandbox-policy`/`approval` 钉在容器可容许的模式、八行租户行——`container-runtime`、`subprocess-container`、`bash-local`、`fs-container`、`session-persistence-postgres`、`tenant`、`tenant-auth-jwt`、`agent-http`——以其导出名挂载。启动测试（`tenant-demo/tests/multi-tenant-loader.spec.ts`）经 Loader 密钥无关、无头地加载 base + web-app + 本 bundle（禁用浏览器表层行、钉住租户行与确定性接缝），断言每个被替换 provider 都解析到位——它暴露了两处仍需解耦而非 provider 列表的契约：`permission`（如上禁用）与 `workspace` 注册表启动时的全局 `sessionPersistence.list()` 扫描，后者如今读到空租户作用域（Postgres store 的 `list()`/`listSnapshots()` 在租户外返回空行，故扫描索引空集而不再让启动失败）。`dsh.cordis-config` 门通过（每个插入行都从该 bundle 自己的 `dependencies` 解析）。launcher 如今也随附该 profile：`apps/cli` 依赖该 bundle，`PROFILE_TEMPLATES` 增加 `multi-tenant`（`['dsh-base','dsh-web-app','dsh-multi-tenant']`），因此 `dsh --profile multi-tenant` 会治愈与启动测试相同的单锚点扁平 fallback。

### 容器工具执行平面：ip+host 服务、懒加载、无状态

引入一个小的每租户 *tool-exec 服务*镜像（由 `container-docker/docker/Dockerfile` 从零依赖服务 `container-docker/src/tool-exec.ts` 构建，一个极简 Node HTTP 进程），在每租户一个主机发布端口上以 HTTP+JSON 暴露一个原语：

- `POST /exec`——`{ argv, cwd?, env?, stdin? }` → `{ exitCode, stdout, stderr }`；文件系统平面复用同一端点，在容器内用 shell 调 `stat`/`cat`/`find`/`base64`，因此无需专门的 `/fs` 面。

`DockerContainerRuntime` 从 `docker exec -i` 改为：懒加载地 `docker run -d` 该 tool-exec 镜像，挂载租户工作空间与工具并发布一个主机端口（`-p 127.0.0.1::8642`）；运行时等待该地址上的 `/exec` 服务应答——设有上限，因为 `docker run -d` 在容器内 Node 绑定端口之前就返回——然后记下该 `ip:port`，`ContainerSubprocessRuntime` 与 `ContainerFileSystem` 都通过 `ctx.containerRuntime.exec` 触达它。这就是"ip+host"交互：agent 平面绝不会为一次工具调用去跑 Docker CLI，而是在一个主机地址上访问容器的 tool-exec 服务。每次工具调用仍在该租户容器**内部**执行，且只有挂载是持久状态；容器自身文件系统在回收时丢弃。

懒加载与快速启动源于同一机制：`ensure(tenant)` 仍在第一次 `exec`/`fs` 解析时触发，但镜像是小型的预构建 Node 镜像（一次性拉取后亚秒级启动）；每租户空闲超时回收容器，只有挂载状态的特性使重启成本很低。一个从不触碰 `ctx.fs`/`ctx.subprocess` 的租户绝不会触发 `ensure`，因此无工具路径单独在 agent 平面完成。

### 租户维度的 settings、credentials 与 memory

`settings-file` 与 `credentials-local` 在 `Tenant.dataRoot` 下解析（而非单一 `$DSH_HOME`）；`storage-domain` 把 `workspace`、`session_projcache`、`message-feedback` 以及租户 memory 域路由到 `postgres` 后端（每租户 schema）。这补齐了第一阶段留空、按 tenantId 严格键控的广度。

### 包增量

| 包 | 路径 | 变更 |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-http` | `tenant/agent-http/` | 新增：`ctx.agentHttp` 租户鉴权载体，包裹 `toFetchHandler(ctx.apiProxy)` + 限定范围 mux SSE |
| `@deepseek-ai/dsh-tool-exec` | `tenant/tool-exec/` | 新增：容器内 HTTP exec/fs 服务（镜像） |
| `@deepseek-ai/dsh-container-docker` | `tenant/container-docker/` | 懒加载 tool-exec 容器 + 主机端口发布；空闲回收 |
| `@deepseek-ai/dsh-subprocess-container` | `tenant/subprocess-container/` | 到 tool-exec 服务的 HTTP 客户端 |
| `@deepseek-ai/dsh-fs-container` | `tenant/fs-container/` | 到 tool-exec 服务的 HTTP 客户端 |
| `@deepseek-ai/dsh-tenant-demo` | `tenant/tenant-demo/` | 对等 e2e：真实 agent 轮次 + 无工具轮次 |
| `@deepseek-ai/dsh-multi-tenant` | `bundle/multi-tenant/` | profile bundle：base/web-app 之上的七处禁用 swap + 租户载体，已组合与启动实证 |

## 否决的方案

- **整体复用 `host/apiproxy` + `client/connection`**——现已成为选定路径：`ctx.apiProxy` 本身就是完整的单用户接口，`toFetchHandler` 与 mux SSE 正是需要租户化包裹的载体词汇。其浏览器花名册信任（WebSocket 下行、DNS-rebinding 围栏、loopback 门禁）位于 `client/connection`，多租户载体用 bearer 鉴权 + `runWithTenant` 替换它，从而继承 RPC 契约、只替换信任围栏。唯一继承而来的局限是可见性：`apiproxy` 在同一个共享 ctx 上广播所有进程内会话，因此 `agent-http` 把 `session.list`/`session.search` 及 `events.mux`/`events.host` 上的会话作用域帧限定到环境租户的会话；主机平面帧（workspace 快照、`remote-event` 允许清单）仍原样放行。
- **保留 `docker exec` 只加空闲回收**——最简单，但让 agent 平面耦合 Docker CLI，无法给出按地址访问容器的无状态后端。否决，改用 ip+host tool-exec 服务。
- **每次工具调用一个短命容器**——隔离最强但每次调用都要重新付启动延迟；快速 tool-exec 服务 + 空闲回收以摊薄的启动成本给出近似等价的无状态性。选：每租户服务 + 空闲回收。
- **一层主机级 tool-exec 网关来 spawn 容器**——保住网络一跳，但把 Docker 访问推进一个独立网关进程；严格比直接发布容器内服务更多部件。暂否决，若将来多副本需共享一个容器池再议。

## 验收标准

- `agent-http` 以三处 provider 替换启动 Web-GUI 宿主栈，服务完整的 `ctx.apiProxy` RPC 接口与 mux SSE（按租户限定范围）；一个真实多轮编码任务与一个 subagent/workflow 任务都能运行并持久化租户键控的会话事件。
- 无工具路径被证明：一个不需要工具的租户 prompt 以**零**次 `containerRuntime`/Docker 调用返回已完成轮次（显式断言，而非"无错误即证明"）。
- tool-exec 容器只在首次工具使用时启动；`ContainerFileSystem` 通过执行器拒绝 `/workspace`/`/tools` 之外的路径。
- `settings`、`credentials` 与每个已配置的存储域都按租户解析；跨租户读取不可表示。
- 完整对等 e2e 在 192.168.138.130 上对着 Postgres 与 Docker 真跑通过。

## 进展

bundle 已在本地经 Loader keyless 启动实证，载体链路也已于线上实证（`http-parity`）；生产接线（`apps/cli` 依赖 + `PROFILE_TEMPLATES`）与七处禁用 swap（`permission` 被禁用、`sandbox-policy`/`approval` 钉在容器可容许的模式）均已合入。生产 `dsh --profile multi-tenant` 启动现已在 192.168.138.130 上对真实 Docker/Postgres 运行：一个 bearer-JWT `session.create`/`session.list` 往返把会话持久化进按租户分区的 Postgres schema（`tenant_acme_*`/`tenant_beta_*`），跨租户隔离成立（acme=1/beta=0，随后 beta=1/acme=1），缺失或错误令牌返回 401。一个真实 LLM 无工具回合也经同一载体跑通（`session.prompt` → agent loop → 经官方端点的 `deepseek-v4-flash`，答案作为 `assistant/message` 记入会话历史）——无工具路径在 agent 平面完成、不触容器。此外一个真实 LLM 工具调用回合也已跑进懒启动的租户容器（bash 工具 → `subprocess-container` → `containerRuntime.exec` → `dsh-tool-exec` 容器的 `POST /exec`，输出回传给模型）——工具路径对显式 `cwd` 与现在的**默认无 cwd 会话**都已实证。途中发现并修复了两个容器 bug：tool-exec 镜像的 Debian-slim 基础缺 `bash`（`bash-local` 执行器以 `bash -c` 方式 spawn）——现已在 Dockerfile 中安装；以及网关把会话 cwd 默认成 Host `process.cwd()`（`/root/work/deepseek-harness`），该路径在容器内不存在，所以即使 `bash` 存在、每次工具 spawn 仍以 `spawn bash ENOENT` 失败。网关现接受 `cwd` 配置（`ApiProxyService.Config.cwd`，缺省回退到 `process.cwd()`），多租户 bundle 钉住 `api-gateway.cwd: /workspace`，与容器的 `tenant.workspaceRoot:/workspace` 绑定及 `fs-container.root: /workspace` 一致。租户维度 settings、credentials、持久化存储与 workspace 注册表随后落地并在服务器实证：`settings-file` 解析 `<tenant.dataRoot>/settings.yaml`（base 服务按租户键控其快照、无租户回退 `$DSH_HOME/settings.yaml`），`credentials-local` 解析 `<tenant.dataRoot>/.credentials.yaml`，bundle 把 `storage-json` 换成 `storage-postgres` 并把 `storage-domain` 重指向 `postgres`，同时 workspace 注册表按租户懒打开、无租户作用域 fail-safe；在 192.168.138.130 上真实 LLM 工具回合、acme/beta 会话隔离、按租户 workspace 列表、按租户 `kv_*` schema 均已实证。仍待办：`workspaceId` 仍只在当前租户注册表内选择（无按租户 workspace id 索引），且两个 boot 期存储域消费者（`session-projection-cache`、`message-feedback`）在 domain 层做到按租户延迟前于无头 profile 中禁用。

## 风险

- **无状态副本上的 SSE**——绑定单个副本的下行链路会在故障转移时断开；载体必须以事件回放（而非存活）为契约，使客户端可重连并回放。用重连测试证明。
- **tool-exec 镜像构建与端口卫生**——主机发布端口绝不能路由到主机之外，且回收时必须释放；用空闲超时后套接字消失的断言测试。
- **对等漂移**——载体组合必须显式 include headless 主干，使单租户改动自动到达多租户；用一个同时启动两者、比较工具目录与会话事件类型的 keyless e2e 守护。