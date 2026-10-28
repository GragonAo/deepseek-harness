# Agent Note: Session delete tombstones the identity for the life of the process

Status: implemented

[English](2026-10-19-session-delete-tombstones-the-identity.md) | 中文

## Problem

把会话收起来并不等于移除它：`workspace.archiveSession` 把它从分组界面隐藏，取消归档又会恢复它的位置，因此没有任何宿主调用能擦除一段对话（[归档决策](../feature/2026-07-31-session-archive-global-set.md)）。存储 seam 能删除已存的日志（[日志删除决策](2026-10-19-session-log-deletion.md)），workspace 注册表也会遗忘某个会话的记账（[遗忘决策](2026-10-19-session-forget-removes-registry-accounting.md)），但这两个操作都不会让一个身份不再是一个会话，而关于被移除身份的下面三个事实属于网关：

- **普通会话在回合结束后仍保持附加。** 网关在内存里持有它的 `Session`，而没有任何环节拆除这个 Session：`AgentRegistry` 不提供驱逐，唯一的拆除路径是 `create()`/`resume()` 交给创建该 agent 的消费方的 `AgentHandle.dispose()` 能力，而本网关只保留 `handle.agent`（[记录该生命周期被保留的实测](2026-08-03-per-session-agent-presets.md)）。
- **`session.list` 合并两个来源**：内存中已附加的会话，以及持久化服务列出的冷会话。因此只删日志会留下内存一半列出的这个 id——一段已被移除的对话继续占着侧栏行，而 `session.search` 搜索的正是 `session.list` 返回的那些行。
- **workspace 记账是第三个存储**：每个持有该 id 的 workspace 记录中的 `sessionIds` 席位，以及注册表全局的 `archivedSessionIds` 集合。二者的存活时间都长于日志。

收口这个状态不能是持久的：重启后没有任何东西处于附加状态，也就不存在能重建日志的写入方，后端报告的持久缺席即是全部事实（[日志删除决策](2026-10-19-session-log-deletion.md)）。缺的是进程内的状态。

## Decision

**`session.delete` 组合这两次移除，并依赖持久化后端进程内的已删除状态来让该身份不再可寻址。**

线上协议：`session.delete({sessionId}) → {deleted: true}`，注册为一个 `session.*` 一元方法——`SessionsApi.delete` 是签名出处，`sessionDeleteRequestSchema`/`sessionDeleteValueSchema` 是它的线协议校验，另有 `RpcMethodMap` 条目、`UNARY_ROUTES` 分发条目，以及载体客户端的对应一元方法。

- **不可逆，且与归档是不同的动作。** 日志是会话所显示内容的权威来源，因此删除没有返回路径。`workspace.archiveSession` 隐藏会话并保留其注册表席位，以便取消归档时恢复；需要那种可逆动作的调用方有那个方法，而 `session.delete` 不承诺它的返回。
- **拒绝。** 正在跑回合的会话以 `agent-busy` 与 `details.reason: 'TURN_RUNNING'` 拒绝，两个存储都不触碰，所以调用方要先取消。背后是 subagent 的会话以各按会话寻址方法共用的 subagent 归属 `agent-busy`（`use subagent delivery for this child session`）拒绝。未组合会话持久化的部署应答 `internal` 并指出缺失的服务，因为删除是后端自己要声明的能力。持久化失败不是业务回答：该操作直接拒绝，经载体即为 500，绝不会是客户端会读成关于会话本身回答的 `session-not-found`。
- **提交顺序：日志先，workspace 记账后。** `SessionPersistence.delete` 是会因持久性失败的步骤，而 `forgetSession` 是幂等的，所以失败的尝试留下的是一个仍然存在、仍被记账、仍然找得到的会话，重试即可把删除做完。相反的顺序会先毁掉一个仍然存在的会话的记账，并发布由该移除派生的归档与分组快照。
- **已删除状态收口了什么。** `session.list` 与 `session.search` 不再列出该 id，因此列表的内存一半无法把它复活；解析会话的读取退回日志读取，并因日志确已消失而应答 `session-not-found`——经 `readSessionState` 的读取（`session.fork`、`session.attachment`）与经 `historySourceFor` 的读取（`session.history`）皆然；`session.prompt` 在任何 agent 解析之前于回合闸门处拒绝，因此残留 Session 不会被受理任何其日志写入会被墓碑拒绝的回合；`ensureSession` 在入口处拒绝该 id，不会恢复或创建它；仍然附加的 Session 后续的日志写入被后端拒绝，而不会把已删日志重新实体化。
- **载体在网关之前为该方法把关。** `@deepseek-ai/dsh-agent-http` 把 `session.delete` 加入按 `sessionId` 寻址的方法集合，在委托之前按环境 `(tenant, user)` 解析，因此他人的 id 一律以 `session-not-found` 应答，绝不进入共享网关。

## Why the composition lives in `dsh-host-apiproxy`

网关同时持有身份必须离开的两个来源——内存中已附加的会话与持久化列表——而且它本来就是唯一把 id 解析成会话或 agent 的地方，所以已删除状态的检查与提交顺序就落在 `ensureSession`、`readSessionState` 和列表合并所在之处。`@deepseek-ai/dsh-workspace` 持有注册表状态，它的 `forgetSession` 有意把删除留给调用方（[遗忘决策](2026-10-19-session-forget-removes-registry-accounting.md)）；而持久化后端对已附加会话一无所知，因此无法判定一个身份何时不再可寻址。

## Why the carrier must gate it

网关通过其 provider 读取的环境 `(tenant, user)` 权威来限定请求，但 `session.delete` 指称的是一个活在进程级 agent 注册表里的身份，而多租户载体为所有租户服务同一个共享网关（[多租户切片](2026-08-24-multi-tenant-slice.md)、[用户成员资格决策](2026-08-26-tenant-user-membership.md)）。不加这道关卡，一个租户的请求就能删除另一个租户的存活会话，而被删掉的日志正是那个租户的数据。因此载体在委托之前先解析该 id，与其他按 `sessionId` 寻址的方法完全一致；同一次处理还会把 `session.list`/`session.search` 的条目过滤到本租户未归档的会话：归档会话为其取消归档保留了注册表席位，但列表继续显示它就是在端出该租户已经收起来的会话。

## Alternatives considered

- **只删日志，让列表自行收敛。** 否决：Session 仍然附加，`session.list` 的内存一半继续保留它的行，于是这个会话看起来还活着，却拒绝任何写入。
- **驱逐存活 Session，而不是依赖已删除状态。** 不是落地的机制，而是延后的改进：本网关手上没有可销毁的 `AgentHandle`，而 `AgentRegistry` 不提供对由其他消费方进入的 agent 的驱逐，所以删除路径无法拆除它并不拥有的 Session（[preset 决策](2026-08-03-per-session-agent-presets.md)）。
- **为已删除身份写入持久标记。** 否决：标记与日志移除之间崩溃会留下一个被列出却读不到的会话，而重启后持久缺席本身已经回答了这个问题（[日志删除决策](2026-10-19-session-log-deletion.md)）。
- **拒绝删除已附加的会话。** 否决：普通会话在回合结束后仍保持附加，而这正是用户要求擦除的那个会话，所以这道守卫会让该操作在 web 宿主里无法使用。
- **把归属把关放在网关里，而不是载体里。** 否决：网关的限定来自环境请求权威，它回答的是该请求而非请求指称的那个身份，而破坏性方法需要在共享注册表被触及之前完成寻址检查。

## Consequences

- 已删除状态是进程内的，因此让删除跨重启依然成立的是持久缺席，重启后的宿主可以再创建同一个 id（[日志删除决策](2026-10-19-session-log-deletion.md)）。
- 这道栅栏覆盖解析会话的读取、回合闸门、`ensureSession` 以及两个列表界面，但并非全覆盖：`session.models`、`session.selectModel`、`session.rename`、队列编辑与 `session.cancel` 控件、goal 各动词、agent preset 切换以及 `skill.list` 按身份而非经回合闸门解析残留 agent，因此仍会够到那个 Session——其中写日志者被持久化墓碑拒绝，只读取者则像该会话仍然存在那样应答——因为删除身份并不驱逐它的存活 Session。
- 被删除的 Session 会一直占用内存直到进程退出，因为没有任何环节驱逐它——面向消费方的表述见[包 README 的已知限制](../../../../packages/host/apiproxy/README.md#known-limitations-and-deferred-work)。
- 删除态读口位于服务定义上，而不在网关里。`SessionPersistence.isDeleted(id)` 就是协调器为其写入拒绝本就持有的墓碑集合，由各后端转发，因此网关问的是拥有该事实的唯一一处，而不是自建第二份删除集合；与 `delete` 一样它只存在于进程内，重启后持久缺失就是全部事实，因此重启之后它答 `false`（[日志删除决策](2026-10-19-session-log-deletion.md)）。

## Testing

`packages/host/apiproxy/tests/api-proxy-delete.spec.ts` 固定了各类拒绝围栏（正在跑的回合、带 origin 标记的 subagent、父 agent 当前拥有的存活子会话、未挂持久化）、以一份有序调用日志表达的提交顺序（`persistence.delete` 先于 `workspaceRegistry.forgetSession`）、持久化失败在实现里直接拒绝并经载体应答 500、`session.list` 丢掉该行而存活邻居保留、转写读取（`historySourceFor`）与 `readSessionState` 读取各自应答 `session-not-found`、回合闸门拒绝为已墓碑化但仍附加的会话开启回合、`ensureSession` 拒绝重建该 id，以及这种会话的残留模型目录按现状被观测记录。该方法的注册与其他同族方法一起固定在 `packages/host/apiproxy/tests/fetch-carrier.spec.ts`、`client-handler.spec.ts` 和 `rpc-schemas.spec.ts` 中。存储移除与它的进程内已删除状态属于持久化包自己的约定（[日志删除决策](2026-10-19-session-log-deletion.md)）；workspace 记账那一半是 `packages/workspace/workspace/tests/workspace.spec.ts`（[遗忘决策](2026-10-19-session-forget-removes-registry-accounting.md)）；载体的寻址检查与归档条目过滤是 `packages/tenant/agent-http/tests/agent-http.spec.ts`。
