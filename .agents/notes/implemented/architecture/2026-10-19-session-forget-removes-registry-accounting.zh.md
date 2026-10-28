# Agent Note: Session forget removes registry accounting and the archive slot

Status: implemented

[English](2026-10-19-session-forget-removes-registry-accounting.md) | 中文

## Problem

硬删除一个会话会移除它的日志、存活 agent 和遥测数据。但没有任何环节告知 workspace 注册表——而注册表为它保留了两处持久痕迹：workspace 记录 `sessionIds` 里的席位，以及注册表全局的 `archivedSessionIds` 集合。二者的存活时间都长于会话本身。残留的席位会让 workspace 的会话数量与候选顺序失真；残留的归档成员关系则让该 id 继续留在 `host/archived-sessions-changed` 快照里，而租户载体正是按这个快照过滤客户端帧的，于是帧会持续指称一个已不存在的会话。归档有意保留席位，因为之后的取消归档要恢复该会话的位置；被删除的会话没有任何位置可恢复，因此那条保证对它不成立。

## Decision

**`ctx.workspaceRegistry.forgetSession(sessionId)` 将当前请求分区注册表状态中的一个会话彻底移除：所有持有它的 workspace 记录都从 `sessionIds` 中删掉该 id，同时该 id 离开 `archivedSessionIds`。**

- 提交顺序：记账写入先提交，归档写入最后提交，因为订阅方正是从归档快照派生帧。记账阶段失败会直接拒绝且不写归档，因此绝不会出现某个帧声称归档已移除、而 workspace 记账仍在相反地持有该 id 的情况。每次写入各自持久；该操作不使用待处理变更标记（见备选方案）。
- 幂等与拒绝：未被任何记账持有且不在归档集合中的 id 完全不写入，而该分区从未见过的 id 同样视为成功。`archiveSession` 会拒绝这类 id（`WorkspaceUnknownSessionError`），因为归档集合是用户可见会话的显示事实；遗忘则跟随删除发生，会话不存在本来就是预期状态，所以部分删除后的重试绝不能因为它而失败。
- 写入范围：只写真正持有该 id 的记录，且以持久记录而非过滤后的 `sessionIds` 投影判定——被投影隐藏的候选仍然算作持有，会在这里被删除；无关的 workspace 则绝不重写（因此也不会因这次操作而发出变更帧）。
- 不触碰 workspace 注册记录：目录仍然保持注册状态，最后一个会话被遗忘的 workspace 保留为空分组，而不是消失。

## Alternatives considered

**由硬删除路径自行逐 workspace 解绑并删除归档条目。** 否决：该路径在本包之外，必须先枚举 workspace 再写入，且无法在不把这条顺序规则复制到第二个归属地的前提下保证归档写入最后提交。

**连 workspace 记录一起删除，而不是只删席位。** 否决：注册记录代表目录，而不是会话。删除单个会话不应注销该文件夹或它的其他会话。

**先写归档集合，再写各记账。** 否决：第一次写入会发布一个不含该 id 的归档快照，而 workspace 仍然持有它；若两次写入之间失败，被删除的会话会重新出现在所有分组视图中。

**像 create/delete 那样使用持久待处理变更标记。** 否决：`pendingMutation` 的存在是因为一个 workspace 被拆分到顺序单例与 `workspaces` 表两处，中断的成对写入会留下启动时无法解释的顺序／表分叉。而这里的两处写入是彼此独立的事实——一个记账席位与一条归档成员关系——中断只会留下可读状态（已归档、未记账），重复调用 `forgetSession` 即可收敛，也不会给启动恢复引入新的顺序／表分叉。

**把 `Workspace.detachSession` 直接作为公开的遗忘入口。** 否决：它只作用于单个 workspace，调用方仍需要注册表已经持有的那套枚举，而且它无法表达归档那一半。`forgetSession` 在内部复用它，从而只保留一条 workspace 记录写入路径。

## Consequences

[会话归档决策](../feature/2026-07-31-session-archive-global-set.md)中的归档席位保证只维持到硬删除遗忘该会话为止；对于所有仍然存在的会话，取消归档依然恢复其位置。这里删除的不是会话、日志或目录：`forgetSession` 只修改注册表状态，其余一切由调用方负责，因此对存活会话调用它只是让该会话变为未分组。若在记账写入与归档写入之间失败，该 id 会处于已归档但未记账的状态，重试即可补全——而相反顺序的失败模式（id 已取消归档却仍被记账、重新可见）正是当前顺序所避免的。

## Testing

`packages/workspace/workspace/tests/workspace.spec.ts` 固定了两处移除及其发出的变更顺序（`workspaces` 写入先于全局写入）、只有记账一半与只有归档一半的两种情形、对已遗忘 id 与未知 id 的无写入幂等，以及一次注入的记账写入失败：它不发布任何内容并在重试时完成。调用该方法的硬删除路径、它的 RPC 表面以及租户载体的帧过滤，都由各自包内的测试套件固定。
