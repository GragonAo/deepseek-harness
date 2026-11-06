# Agent Note: 注册表读操作先打开它自己的请求分区，再做投影

Status: implemented

[English](2026-11-05-registry-read-opens-its-partition.md) | 中文

## Problem

重启 171 上的租户宿主（`dsh/dsh-tenant-host`，租户 `cv5ajfbnoaykmug7dcvrpa`，用户 `cs`）之后，用户此前归档的五个会话重新出现在会话列表里。什么都没有被删除：该分区的 Postgres 行仍然带着归档集合（`kv_global`，`unit='workspace'`，`user_id='cs'`，`version=2`，五个 id），后来一次写入重新发布时这五个 id 仍在 `archivedSessionIds` 里。重启改变的只是投影：`workspace.list` 回答 `{"items":[],"archivedSessionIds":[]}`，`session.list` 返回全部 29 个会话，其中五个是用户已经收起来的。对一个**已归档** id 调一次幂等的 `workspace.archiveSession`——一次不写任何东西的调用——两个面都恢复了，列表降到 24 条。

机制是惰性打开的请求分区。`WorkspaceRegistry` 在 `ensurePartitionState()` 里打开请求分区，而只有异步方法会调它，因此分区化部署的 `[Service.init]` 走 `NO_TENANT_IN_SCOPE` 分支进入未初始化状态，此时所有投影都回答空。网关的 `workspace.list` 处理器同步投影 `list()` 与 `archivedSessionIds`，租户载体又用同一个同步 getter 过滤 `session.list`，于是凡是由「还没写过任何东西」的进程服务的读操作，描述的都是一个空注册表。客户端没有错：它自己的过滤是对的，是收到的空基线让每个已归档会话重新可见。同一个缺口也覆盖 `sessions.create({workspaceId})` 与 `sessions.fork`——它们通过同步的 `get()`/`list()` 解析工作区，在别处发生写入之前会回答 `workspace-not-found`。

## Decision

`ctx.workspaceRegistry.ensureLoaded()` 打开环境请求分区，并在其 domain、header 索引与实体缓存建好之后 resolve。它是注册表的读门：打开是记忆化的，重复调用只花一次 promise 跳。

两个调用点在投影之前 await 它：

- 网关的 `workspace.list`：它的 `items` 与 `archivedSessionIds` 就是客户端的重连基线；
- 租户载体：每个通过鉴权的请求一次，在委托给网关之前由 `loadRegistryPartition()` 执行。

载体这道门才是让同步投影在**整个请求**范围内正确的关键，而不只是在单个处理器上：在 `runWithTenant` + `runWithUser` 之内，环境分区就是该请求的分区，在那里打开它同时服务于 `session.list` 的归档过滤、`sessions.create` 的工作区查找、`sessions.fork` 继承的工作区、那些先读后写的 `workspace.*` 处理器，以及 `events.host` 流的帧去重基线。这道门上的 workspace 存储故障只记录并吞掉：注册表只是载体背后众多服务之一，载体还要应答根本不碰它的请求；而网关的 `workspace.list` 允许故障穿透，因为客户端拿着空归档集合行动正是这道门要防的缺陷。

单分区部署不变：`[Service.init]` 本来就打开它那唯一的分区，`ensureLoaded()` 立即返回。

## Alternatives considered

**启动时打开所有已知分区。** 分区化后端在分区之外打开会拒绝（`NO_TENANT_IN_SCOPE`），分区集合无界且只有介质知道，每打开一个就要载入那个租户与用户的注册表状态，因此服务多租户的宿主会为了「还没人要求」的读操作在启动时把全部数据付一遍。

**把 `list()` 与 `archivedSessionIds` 端到端改成异步。** 它们被同步派生读取——workspace 实体的 `sessionIds` 投影、面向客户端的视图构造、不变式检查——改动会沿着每个消费者扩散，而这个问题在请求边界上由一次 await 打开就能解决。

**让主机流自己打开分区，即把 `events.host` 改成异步生成器（已实现后又回退）。** 在流体内 await 打开会把 `session/created`、`agent/status`、`domain/changed` 的订阅注册推迟到第一次拉取，于是「打开流」与「第一次读」之间发生的事件会丢失——在一个立刻拉取的测试里看不出问题，而在「打开流、稍后才开始读」的客户端里则是一段静默的帧空洞。载体在流请求抵达网关之前就已经打开了分区，所以流保持同步体与即时的订阅注册。

**把归档过滤搬进网关的 `session.list`。** 载体无论如何都要保留自己的归属过滤（跨租户作用域是载体的权威），在网关里再加一份归档过滤只是把同一个决定复制到两层，而不是打开过滤所读的那个分区。

**用就绪探针或运维手册来预热分区。** 探针只能预热它点名的分区，而 171 这次正是这么解决的——每个受影响租户一次幂等归档调用——那是每次重启每个租户一次的手工步骤，而且没有任何东西报告它漏掉的租户。

## Consequences

进程内某个 (tenant, user) 的第一个请求要付一次分区打开——一次介质读加一次引导检查——之后每个请求只付一个记忆化的 promise。读不再取决于同一进程里先前是否发生过写入，因此重启后归档集合、工作区列表、按 id 的工作区查找、以及继承工作区的 fork 都保持正确。

注册表保留同步投影，所以它 README 里原先那条限制（「分区内第一次访问在某个异步方法打开该分区之前是空的」）现在点名的是这道门而不是这个陷阱：跳过 `ensureLoaded()` 的调用方仍然看到打开前的空投影，而那是无分区作用域的单分区路径所依赖的行为。

## Testing

`packages/workspace/workspace/tests/workspace.spec.ts` 在按分区键控的内存后端上覆盖注册表这道门：第二个 harness 在同一份持久介质上启动，打开前投影为空，打开后投影出归档集合与工作区顺序，而另一个（租户、用户）邻居加载后保持自己的空状态。

`packages/host/apiproxy/tests/api-proxy-workspace.spec.ts` 把网关基线钉在门上，`packages/tenant/agent-http/tests/agent-http.spec.ts` 钉住宿每请求一次的打开，包括 workspace 存储失败时保留列表而不是回 500 的故障路径。

## Related

- [归档集合作为注册表全局字段](../feature/2026-07-31-session-archive-global-set.md) 拥有该集合的存储、wire 与客户端基线决定；本便签拥有它的读操作如何抵达持久状态。
- [按用户存储分区](../architecture/2026-08-26-per-user-storage-partition.md) 让分区携带用户，这正是打开按 (tenant, user) 而非按租户进行的原因。
- [会话遗忘移除注册表记账](../architecture/2026-10-19-session-forget-removes-registry-accounting.md) 是进入同一集合的另一条路径，走同一道门。
