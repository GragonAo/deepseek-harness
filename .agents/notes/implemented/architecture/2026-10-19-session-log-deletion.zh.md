# Agent Note：硬删除已存储的会话日志

Status: implemented

[English](2026-10-19-session-log-deletion.md) | 中文

## Problem

已存储的会话只能不断增长。每个后端都只追加，`SessionPersistence` seam 暴露 `create`/`append`/`load`/`inspect`/`readFrom`/`list`，没有任何删除操作，而每个后端的 README 只把这个缺口写成限制、而非提供该操作：「不删除会话文件：日志在 `root` 下累积，直到外部移除（seam 无删除接口）」、「没有删除或后台历史压缩：普通追加只做插入」。因此，需要按用户要求抹掉某个会话的宿主、或承担保留期义务的部署，没有任何受支持的调用可用。它现有的变通做法——解除链接只有后端才知道如何解析的根下的文件，或对只有后端才拥有的 schema 直接执行 DELETE——绕开了维持每会话写入一致的按 id 操作串行化，因而可能与进行中的 flush 交错，留下被删了一半的会话，或删掉一个会被下一次缓冲写入重新创建的日志。

## Decision

### 能力在后端上是可选的，在服务上是必须声明的

`PersistenceBackend<TornMarker>` 增加 `remove?(id, signal?)`：不可逆删除该后端在 id 下持有的全部产物（含元数据），使 `loadStored`、`readStoredRevision`、`list` 不再能看到该会话。它可选，是因为 provider 可能架在无法删除的存储之上；省略它就是该 provider 的声明方式，此时 `PersistenceCoordinator.delete` 会指名 `backend.name` 抛出，说明该后端不支持删除已存储会话。服务定义把该能力声明为抽象的 `SessionPersistence.delete(id)`，且刻意抽象：具体 provider 要么组合协调器、要么自行实现删除，两条路径都无法继承一个静默空操作。四个第一方持久化 provider 都实现了 `remove`，并把 `delete` 委托给各自的协调器。

### `PersistenceCoordinator.delete(id)` 做什么

1. 若本进程已删除该 id 则立即返回；否则等待该 id 进行中的退役，再排在该 id 已入队的任何操作之后串行执行，使删除不会与同一 id 的写入、修复或 preparation 交错。
2. 在触碰任何东西之前，先拒绝没有 `remove` 的后端。
3. 拒绝绑定该 id、且轮次开放的活动会话：该日志记录着仍在进行中的工作，该 Session 会继续向一个已不存在的日志写入，消息带着 `agent-busy` 标记，使传输层能把该拒绝映射为自己的拒绝码。空闲的活动会话（轮次已关闭）可删除——这是常规情况，因为宿主持有它刚用完的那个 Session。
4. 调用 `remove`，把该 id 记入进程内墓碑，并丢弃协调器为该 id 保存的记账：会话写入状态、live controller（取消其批处理窗口，使待写缓冲被丢弃而不是重试）、已缓存 preparation。
5. 删除不存在、从未实体化或已删除的 id 会正常返回：删除并不是在断言该会话曾经存在。

墓碑是该删除在本进程其余时间内成立的原因。`load`、`inspect`、`readFrom`、`prepare`、`list`、`listSnapshots` 报告该 id 不存在（而非空会话），`create`/`append` 以指明该删除的消息拒绝（`cannot append session "x": its stored log was deleted in this process`），而不再重新物化日志。

### 墓碑刻意只存在于内存

重启之后没有任何活动会话、没有 controller 缓冲事件、也不存在会重建日志的写入方，因此后端报告的持久缺失就是全部事实，该 id 重新可用。持久墓碑必须在删除日志之前提交——否则两者之间崩溃会留下一个被列出却读不出的会话——而且进程内集合仍要用于写入拒绝，这就是同一事实的两套机制。需要删除跨进程存活的宿主所依赖的，是存储确实已经消失，而这正是 `remove` 所保证的。

### 删除活动会话的日志不会 dispose 该会话

协调器无权 dispose 其他插件仍在使用的 `Session`，因此 `delete` 让该活动 Session 留在内存中，但没有持久目标。它的下一次写入通过该写入自身的失败路径报告这次删除：显式 `session/flush` 会拒绝，后台写入则记录一条警告并保留该批次。后端拆卸会跳过已进墓碑 id 的 drain 并取消其批处理窗口，因此删除一个空闲会话后随即关闭时，不会因为调用方有意删除的日志而以 `dispose failed` `AggregateError` 让拆卸失败；被跳过的缓冲本就属于那个日志。因此，活动日志在被其所有者 dispose 之前仍可通过该 Session 访问，这与任何活动会话的内存情形相同。

### 各后端的移除方式

- **JSONL** 通过与所有其他操作相同的路径解析，解除链接本根已配置编码对应的那一份产物，覆盖 `session.jsonl` 与 `session.jsonl.zstd`，并拒绝持有相反编码的根。会话目录与项目目录保留：发现逻辑把带有 transcript 的目录视为会话，因此空目录不是会话；而该目录在文档中保留给其他会话自有产物，递归移除会把它们一并带走。
- **SQLite** 在一个 `BEGIN IMMEDIATE` 中删除该 id 在两个表中的行，并在锁内重新校验 schema，因此在变更时观察到的 schema 变化会让整个删除回滚。它自己声明这两条 delete，而不依赖 schema 的外键级联，使该移除覆盖的行集合在调用处可见。
- **PostgreSQL** 在一个事务中、在拥有该 id 的 (租户, 用户) 作用域内删除两个表中的行：物化或成功读取时捕获的绑定会被复用，与 append 完全相同；本进程从未绑定过的 id 则从环境作用域解析。该 id 的绑定随其行一起释放。

## Alternatives considered

- **软删除：隐藏会话、保留字节。** 否决：读族必须在每条路径上过滤标记，保留期义务本就要移除的字节仍会留下，而「隐藏但仍存在」的会话会继续招致这次改动正在替代的带外 `rm`/SQL 变通做法。
- **在 JSONL 中删除整个会话目录。** 否决：该目录保留给其他会话自有产物，空目录不是会话，而递归移除会触及本后端从未写入的文件。
- **依赖 SQLite 外键级联删除子行。** 否决：该移除将依赖某个约束继续按现状声明，而它实际执行的行删除在实现处不可读。
- **拒绝删除任何仍有活动 Session 的 id。** 否决：宿主持有它刚用完的 Session，而这恰恰是用户要求抹掉的会话；这种守卫只会把 dispose 要求推给每个调用方，而墓碑已经让日志保持被删除。
- **持久墓碑行或标记文件。** 否决：为了跨崩溃安全，它需要在删除之前提交，而且它并不消除进程内拒绝的需要。
- **单独的删除服务或 seam。** 否决：移除是现有 seam 已经拥有的存储上的一个操作，第二个 seam 会让每个后端有两处声明同一能力。
- **把墓碑暴露为公开查询（`isDeleted`）。** 已提供：`SessionPersistence.isDeleted(id)` 转发到协调器的墓碑集合，因为消费方必须能区分「已删除」与「从未创建」，而 seam 的其他读取对两者一律回答「不存在」。写入拒绝仍留在做出写入的地方，即协调器内部的 `assertNotDeletedWrite`；该读取与它所报告的那份集合一样只存在于进程内：重启之后，持久缺失就是全部事实。

## Consequences

- 宿主现在可以通过与写入相同的按 id 串行化来抹掉一个会话，且每个 provider 都声明该能力，而不是继承一个空操作。
- 删除是按会话、按 id 进行的：没有按时间、大小或数量的保留策略，没有批量删除，也无法删除日志的一部分——仅追加不变量不变。
- 两个 SQL 后端都不归还文件空间：SQLite 保留其空闲页，PostgreSQL 保留其页面，因此回收磁盘仍是带外的 `VACUUM`/autovacuum。JSONL 会留下空会话目录。二者均记录在后端 README 中。
- 被删除会话的活动内存日志不会因 `delete` 而释放；在意的宿主应 dispose 该 Session。
- 每个 `SessionPersistence` 实现方现在都必须声明该能力，测试替身也一样：本次改动中有五个其他包的测试替身各增加了一行实现。
- 没有任何持久记录记载某会话已被删除，因此重启后的宿主可以再次创建同一 id——这一点写在服务 JSDoc、seam README 与本 Agent Note 中，而非强制禁止。

### Verification

- `packages/session/session-persistence/tests/coordinator-contract.ts` 针对每个协调器后端夹具（内存参考实现、JSONL `none`、JSONL `zstd`、SQLite）运行四个删除用例：读族（`list`、`listSnapshots`、`load`、`inspect`、`readFrom`、`prepare`）把已删除 id 报告为不存在、同时幸存会话完好，重复删除与从未存储 id 正常返回；`agent-busy` 拒绝后、同一会话在轮次关闭后可成功删除；日志被删除的活动 Session 的下一次写入失败、拆卸时不会复活该日志、同一存储上的第二个实例也找不到任何内容；以及第二个协调器可重新创建该 id，证明墓碑没有变成持久状态。
- `packages/session/session-persistence/tests/persistence.spec.ts` 覆盖指名后端的能力拒绝，以及删除清空的协调器记账（写入状态、live controller、已缓存 preparation）。
- `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` 与 `zstd.spec.ts` 覆盖两种编码的解除链接、会话目录保留、发现逻辑忽略该空目录、不存在 id 与缺失根的空操作、以及预先中止的信号；`packages/session/session-persistence-sqlite/tests/sqlite.spec.ts` 覆盖两个表的物理行删除、schema 变化时的事务回滚、以及预先中止的信号；`packages/tenant/session-persistence-postgres/tests/store.spec.ts` 覆盖按绑定作用域的归属删除、绑定释放、环境作用域路径、以及预先中止的信号。
