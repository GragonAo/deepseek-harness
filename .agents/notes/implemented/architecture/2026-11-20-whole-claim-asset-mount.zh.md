# Agent Note: 整块资产卷挂载

Status: implemented

[English](2026-11-20-whole-claim-asset-mount.md) | 中文

部分取代 [把工作区 claim 之外的存储接进沙箱挂载表](2026-11-19-asset-claim-mounts.md)：逐源清单照旧，但它当时否掉的「一对 claim + 根」现在正是部署挂整棵资产树的方式。

## Problem

`Config.assetMounts` 一项挂一个源，且每项的 `subPath` 必须是 claim 内的非空路径。因此，把共享资产放在某块 claim 根上的部署无法描述它们：没有任何一项能表示「就是这块 claim 本身」。它只能逐层点名（`system`、`pyenv`），而这就把卷的内部布局同时写进了两处——chart 的取值与程序的 `systemRoot` / `pythonRoot`——并且没有任何东西检查两者是否一致。这套代码服务的部署要的正相反：把共享卷整块只读挂进来，卷里哪些目录有意义，由程序自己的配置说了算。

## Decision

`Config.assetsClaim` 与 `Config.assetsRoot` 把一块 claim 整块挂在某个路径上。该挂载只读、不带 `subPath`；卷里有哪些目录是部署自己的事，由指向 `assetsRoot` 之下的 `systemRoot` 与 `pythonRoot` 表达。

于是 `sandboxMounts` 会从常规表里去掉这样的源：源本身等于它的挂载点、且位于 `assetsRoot` 之内。这一层已经随整卷可见，再挂一次只会让同一份数据出现在两个路径上。位于别处的源仍各自挂载；活例子是技能聚合根（`/opt/data/skills/system`），它投影出的 `subPath` 相对卷根是 `system/skills`。整卷那一条排在最前，聚合根本地父目录因此仍在它之前被创建。

加载期校验在 `assetMounts` 已有的基础上再加几条：两个字段要么都给要么都不给，`assetsRoot` 是绝对路径、其 claim 非空，必须是 claim 模式，且 `assetsRoot` 与 `claimRoot` 互不包含——资产卷落进工作区 claim 里，删一个租户就会把它删掉。

## Alternatives considered

**只加「一对 claim + 根」而不保留逐源清单**——2026-11-19 那篇否掉的形式。单独用它仍然是错的，理由就是那篇写的：`/case` 与用户全局那棵树留在工作区 claim 上，逐源清单本来就需要。那篇不需要、而这个部署需要的是「把一块 claim 整块挂进来」；两种机制并存。

**允许 `assetMounts` 里出现空 `subPath`。** `subPath: ''` 不是中性值：它会以空串进到 pod spec，kubelet 据此去找一个不存在的子目录。继续拒绝。

**整块卷挂成可写。** 运行时路径上没有任何东西写它；只读把「误写」变成响亮的报错，而不是悄悄污染一块被所有租户共用的卷。唯一合法的写入方是平台的系统技能安装器，由 chart 单独以可写方式挂载——那是部署的选择，不是 provider 的。

## Consequences

provider 不再需要知道卷的布局，换布局就是改程序配置。代价是：`assetsRoot` 写错，或卷里缺少程序点名的目录，只在真去读时才暴露——不带 `subPath` 的 claim 挂载本身永远成功，没有「源缺失」的信号。

成对要求在加载期与 `sandboxMounts` 里各把关一次，所以只写一个字段的配置在写下的地方就失败，而不是等到第一个沙箱。

`container-docker` 没有对应物：它一次挂一个宿主目录，没有可以整块挂的 claim。

## Testing

`packages/tenant/container-k8s/tests/asset-mounts.spec.ts` 钉住整卷挂载（一条、只读、不带 `subPath`）、同路径层的缺席、聚合根的相对 `subPath`、仍留在工作区 claim 的层，以及每一条加载期拒绝。`packages/tenant/tenant-app/tests/app.spec.ts` 钉住把这两个字段带过去的读取器。