# 第 12 章 · 会话数据面

> 阶段：精通。会话日志如何落地、如何被高效投影与查询、以及周边存储设施。参考：[`docs/subsystems/persistence.md`](../docs/subsystems/persistence.md)、[`docs/subsystems/session-projection.md`](../docs/subsystems/session-projection.md)、[`docs/subsystems/session-query.md`](../docs/subsystems/session-query.md)、[`docs/subsystems/storage.md`](../docs/subsystems/storage.md)、[`docs/persistence-catalog.md`](../docs/persistence-catalog.md)。

## 核心原则：内存 Session 是真源，持久化是订阅者

`Session` 只在内存；`session/event` 是**同步**通知，持久化插件订阅它、把事件复制进逐会话控制器，在 `session/flush` / dispose / 批窗口到期时落盘。**热路径从不阻塞 I/O。**

## 1. 持久化 seam（`ctx.sessionPersistence`）

抽象 `SessionPersistence`（`packages/session/session-persistence/src/index.ts`）在现有 `SessionEvent`/`SessionEventMap` 词汇上定义操作——**没有平行的持久化事件类型**：`locate` / `create` / `append` / `prepare` / `load` / `inspect` / `readFrom` / `list` / `listSnapshots`（+ 可选 `readRaw`）。

### 首方后端的三段组合

后端无关的编排用**组合而非继承**（[`docs/subsystems/persistence.md`](../docs/subsystems/persistence.md)）：

- `PersistenceBackend`（`coordinator.ts:127`）：`loadStored` / `readStoredRevision` / `loadStoredFrom?` / `appendBatch` / `commitRepair` / `list` / `locate?`——**对一无所知的最小内存接口**，纯存储后端的唯一门槛。
- `PersistenceCoordinator`：拥有「上次成功批次、序号、维修重放、tear recovery」的共享协调器；torn marker 是**不透明**的（只测 `!== undefined` 并回传，从不 inspect）。
- `SessionWriteBehind`：固定 **200ms 批窗口**，失败保序回放、暂停自动重试。

### 两个后端，同一词汇

| 后端 | 形态 |
|---|---|
| `session-persistence-jsonl` | 每会话一个文件：`HeaderLine` 首行 + `packChunkRuns` 合并 `assistant/chunk` 成连续 run + zstd 帧；崩溃安全的原子写 |
| `session-persistence-sqlite` | `sessions` + `events` 两张行表（每 `SessionEvent` 一行）；`scanRows` 以**最后一个 `turn/end`** 定位撕裂尾，`loadStoredFrom` 可按 seq seek |

两者共享同一 `runPersistenceContract` 契约套件。

### flush 检查点与崩溃恢复

第一个待处理事件开启固定批窗口，后续事件加入但不重置截止时间；`session/flush` 取消等待并排空到完全停稳——循环把它用作「认领下一个普通轮次之前」的顺序与错误观察检查点。崩溃后重载发现 `turn/start` 却无 `turn/end` 时**不截断**日志，缝合合成 `turn/end { reason: {kind:'interrupted'} }`（唯一不循环发出的 `TurnEndReason`）；修复只适用于冷会话。

### 格式版本与拒绝

- `SessionHeader.version` 从 `SESSION_FORMAT_VERSION = 0` 盖章；后端对任何其它版本拒绝（无迁移），`SessionFormatUnsupportedError` 给方向性提示。SQLite 另用 `SCHEMA_VERSION = 15`（`schema.ts`）把守文件结构，非当前版在 open 就拒绝、不迁移。
- 不认识的必需事件类型被拒，除非信封带 `ignorable: true`；`SessionHeader`（version/cwd/parentSession/seedLength/origin/delegationDepth/agentPreset）与事件日志**分存**，不进 `SessionEventMap` 也到不了 `deriveMessages()`。

## 2. 投影（projection）与缓存冷读

`SessionProjectionRegistry`（`session-projection/src/index.ts`）订阅**一次** `session/event`，让各领域注册状态驱动的折叠单元：

- `ProjectionDefinition{ key, schema, init, apply, view, stateVersion }` 是**纯函数**单元（`init` + `apply`），从事件折叠出投影快照，声明合并扩展到 `SessionProjectionMap`。
- 水位 = 每 (注册 × 会话) 的 `UnitCell.observedSeq`（`WeakMap`）；`apply` 返回同一引用即**零工作**（结构共享去重）。
- 检查点原语 `restoreFloor` / `restore` / `viewCheckpoint`。

`SessionProjectionCache` 的冷读阶梯 = `recordFor`（绑定 `{createdAt, cwd}` 生命周期）→ `restoreFloor` → `persistence.readFrom(id, floor)` → `restore` → `putSoft` 写回；失败退化为从 seq0 整段重读。写路径两强制点（`turn/end` + `session/disposed`）+ count/interval 节流。列表读取永远不必加载完整日志。

## 3. 会话查询（`ctx.sessionQuery`）

- 引擎 `SessionQueryEngine` 采取**live 优先**：`SessionCorpus` 逻辑语料 + `foldSurface` 分类 surface 节点 + `traceEvent` 替换链/来源/派生 + `traceSession` 血统环检测。
- SQLite 后端 `SqliteSessionQueryEngine`：FTS5（unicode61）双表（persisted + `temp.live`）；游标 `CursorPayload{ instance, scope, fingerprint(sha256 请求), generation, offset }`，`decodeCursor` 校验 instance/scope/fingerprint/generation **全等**，世代变化即 `SESSION_QUERY_STALE_CURSOR`。
- `tool-session-query` 挂 5 个模型工具（`session_search`/`event_search`/`trace`/`event_trace`/`event_read`），workspace 授权。

## 4. 存储中枢（`ctx.storage` → `ctx.storageDomain`）

- `Storage`（hub，**无 IO**）：`BackendRegistry` 让多个后端（`storage-json`、`storage-sqlite`）并列注册；`KvFacet.open` → `KvUnit{ loadAll, putRecord, deleteRecord, setGlobal, close }` 是**不透明 KV** 原语，`UNIT_NAME_RE` 约束 unit/表名。
- `storage-domain` 的 `DomainFacility` 把 `DomainSpec`（zod 记录 schema）经 `descriptorOf` 转 KV 描述子；`KvTable.update` 走每域**单一写链**：先 await 后端耐久 → 改内存 → emit `domain/changed`，**失败内存不动**（发布只在 commit 点，第 4 章第 12 条精神）。

## 5. 周边设施速记

| 设施 | 关键点 |
|---|---|
| `ctx.sessionTitle` | 确定性 first-prompt 回退 + `foldSessionTitle` 折叠区 + 唯一异步 `register(provider)`；投影键 `title: string\|null` |
| `ctx.sessionTelemetry` | 捕获 → `session-telemetry/record` waterfall 脱敏 → `emit` 交后端；OTel Provider 组合 `LoggerProvider`/`BatchLogRecordProcessor`，离开进程 |
| `ctx.spillStore` | `SpillStore.saveText` + `spill-local` 的 `saveTextFile`（`'wx'` / `0600`、`0700` 私根）；`spill-policy` 在 `tools/post-execute` 与 `tools/code-dispatch-log` 双臂上限 + 取回提示 |
| `ctx.attachments` | 内容寻址 sha256 对象 + digest/decoder 双校验，llm 适配器转 provider 原生内容 |
| `ctx.workspaceRegistry` | 在 storage-domain `workspace` domain 上，`bootstrap` + `pendingMutation` 两阶段恢复 + `WorkspaceEntity.mutate` |
| `ctx.sessionReferenceResolver` | 位于 [`packages/context/session-reference/`](../packages/context/session-reference/README.md)（**非** `packages/session/`），把其它会话 bounded 快照投影为持久但不可信的消息上下文 |

## 一句话总结

**内存日志是真源 → 持久化是订阅者 → 投影/查询/存储/title/telemetry 都是这条流派的派生视图**，各自用「水位 `observedSeq`/修订号/缓存行/游标世代」避免整日志重读。下一章把其余能力包做成速览目录。