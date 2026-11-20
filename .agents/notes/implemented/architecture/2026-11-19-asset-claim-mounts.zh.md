# Agent Note: 把工作区 claim 之外的存储接进沙箱挂载表

Status: implemented

[English](2026-11-19-asset-claim-mounts.md) | 中文

部分被 [整块资产卷挂载](2026-11-20-whole-claim-asset-mount.md) 取代：下面的逐源清单按原决定保留，而它为了那份清单否掉的「一对 claim + 根」，现在与它并存用于整块挂载一块 claim。

## Problem

claim 模式的 `container-k8s` 部署把每个沙箱挂载都投影到一块 claim（`workspaceClaim`）上，其根是 `claimRoot`。那块 claim 属于工作区那棵树：租户在里面创建和删除目录，它的寿命跟着租户走。有两个挂载源并不共享这个寿命——Python 运行时（`pythonRoot`）与全局系统层（`systemRoot`）由同一部署的所有租户共用、体量在几百 MB，而且必须在某个租户被删除后继续存在。把它们留在工作区 claim 里，要么每次部署都得再种一份，要么在那块 claim 被替换时一起丢掉。

另一块 claim 是它们的自然归宿，但 `sandboxMounts` 只从那一对配置字段推出 `claimName` 与 `subPath`，任何挂载都指不到别的 claim 上。唯一的口子是 `hostPath`，而它把所有沙箱钉在一个节点上。

## Decision

`Config.assetMounts` 是一个 `{ source, claim, subPath }` 列表。每个条目按精确路径指名一个挂载源；`sandboxMounts` 产出该源时，这个挂载改用条目给的 claim 与 `subPath`，而不是工作区 claim 的。沙箱内路径与只读标志不变，因此无论某一层由工作区 claim 还是资产 claim 承载，沙箱看到的布局都一样。

校验按「什么时候能知道」分开。加载期拒绝：相对的 `source`、空的 `claim`、空/绝对/含 `..` 的 `subPath`、同一个源写两遍（比较时去掉结尾斜杠——`posix.normalize` 会保留它），以及没有 `workspaceClaim` + `claimRoot` 却配了 `assetMounts`——hostPath 模式没有东西可投影。某个租户实际有哪些挂载源只能在租户维度知道，所以「条目是否命中某个源」在出挂载表时检查：命名了一个不是来源的路径会报错并点名它，而不是被静默忽略。

`tenant-app` 读取同一个字段（`sandbox` 小节下的 `assetMounts`）进它的 k8s 沙箱类型并原样下传。那个读取器对未知字段响亮失败，所以字段必须在同一次变更里补上；读取器只校验每一项是对象且三个键非空，路径规则留给 provider。

## Alternatives considered

**再加一对覆盖整棵资产树的 `claim` + `root`。** 两套根只能描述「整张挂载表都在某一侧」的部署；`/case` 与用户全局那棵树留在工作区 claim 上，而运行时与系统层要搬走，所以逐源的对照表无论如何都需要——而这正是本决定替换掉的那种成对写法。

**把资产 claim 挂到沙箱内另一个路径，再把 `pythonRoot`/`systemRoot` 指过去。** 这张挂载表的前提是「源的宿主路径与沙箱路径是同一个字符串」（`systemRoot` 挂在自己的路径上，技能层读它的子目录）。逐层改沙箱路径会让每个已配置的根谎报自己在哪，也不再与 `container-docker` 同义。

**继续用 `hostPath` 在多租户之间共享运行时。** 它要求每个沙箱都跑在放着那个目录的节点上，而这正是 claim 模式要消除的东西；在多节点集群上它是按调度失败，而不是按配置失败。

## Consequences

运行时与系统层成为部署级资产、有自己的 claim，因此删除租户碰不到它们，两块 claim 各自保留自己的回收策略。

provider 只检查条目声明的 claim **名字**；没有任何东西能核对宿主 Pod 挂的就是那块。名字配错因此表现为运行中的沙箱里目录为空或不存在，而不是加载错误。部署必须让 `assetMounts[].claim` 与它挂的卷保持同步。

把已有内容从工作区 claim 搬进资产 claim 是一次离线迁移，provider 不做这件事：先复制那棵树，再加条目。

`tenant-app` 带着这个字段，所以 k8s 的配置面宽了一格，而 `container-docker` 有意不提供它——docker 部署没有任何 claim 可以投影 `subPath`。

## Testing

`packages/tenant/container-k8s/tests/asset-mounts.spec.ts` 钉住投影结果（命中的源取资产 claim 与 subPath，未命中的源仍取工作区 claim）、结尾斜杠不敏感的重复判定，以及每一条加载期拒绝。`packages/tenant/tenant-app/tests/app.spec.ts` 钉住读取器：两个条目都能解析，条目里拼错的字段被拒。