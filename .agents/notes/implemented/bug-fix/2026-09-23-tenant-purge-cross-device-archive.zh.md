# Agent Note: 租户 purge 跨文件系统归档，而不是汇报一次从未发生的移动

Status: implemented

[English](2026-09-23-tenant-purge-cross-device-archive.md) | 中文

## Problem

`tenant.admin.remove {purge: true}` 承诺归档租户的两个宿主机根目录。部署机实测：purge 之后 `/opt/dsh/.dsh/archive/<id>-<stamp>/` 里只有 `data`，`/opt/dsh/tenants/<id>/workspace` 原封不动还在且 mtime 未变，而 API 返回 `{"removed": true}`。

`archiveDirs` 用 `fs.rename` 移动每个根目录，并用 `.catch(() => { /* absent directory: nothing to archive */ })` 丢弃了所有拒绝。归档根（`/opt/dsh/.dsh/archive`）与租户的各个根（`/opt/dsh/tenants`）是该部署的两个独立绑定挂载源，因此落在不同文件系统上，`rename(2)` 对工作区报 `EXDEV: cross-device link not permitted`。这个处理器把该失败读成了「没有东西可归档」。dataRoot 与归档根同属一个文件系统，所以它的 rename 成功，归档槽看起来是完整的。

`mv` 能处理同样的输入，是因为 GNU `mv` 在 `rename` 报 `EXDEV` 时会退化成 copy+unlink；`rename(2)` 没有这种退化，而跨文件系统移动目录本来就没有哪个系统调用能做到。

这正是[沙箱挂载源预检](2026-09-23-sandbox-mount-source-preflight.md)从另一侧指出的同一类缺陷：把真实失败汇报成「不存在」。purge 返回成功，而案件工作区留在宿主机上，磁盘没有释放，目录「看起来还在」是因为它确实还在。

## Decision

`archiveDirs` 把每个根目录交给新的 `moveIntoArchive(source, destination)`，而 `moveIntoArchive` 只吸收一个 errno。

`ENOENT` 就是那个 errno。归档槽的父目录在移动之前刚刚创建，所以两个参数都不可能有别的路径分量缺失：这次 `rename` 报出的 `ENOENT` 只意味着源目录已经不存在，而一个目录已不在的租户，purge 仍然归档还在的东西。其余任何错误码都会到达调用方，因为 `remove` 只在 `archiveDirs` 返回之后才回答 `{ removed: true }`——吸收任何一个都等于汇报了一次从未发生的归档，也就是本笔记记录的缺陷本身。

`EXDEV` 被处理而不是被抛出，因为跨设备移动本就是该部署的正常拓扑：归档根与租户的各个根按构造就是两个独立的绑定挂载源，所以每次 purge 工作区都在跨文件系统移动。把它抛出只会让每次 purge 都失败，工作区依旧留在宿主机上。

移动退化为 `mv` 所做的事——递归复制，然后删除源目录：

```text
await fs.cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
await fs.rm(source, { recursive: true, force: true })
```

每个选项都是关于「归档保留什么」的有意选择。

- `recursive: true` 才是让复制能处理目录树的东西；没有它，`fs.cp` 会拒绝目录。
- `preserveTimestamps: true` 保留每个文件的 mtime 与 atime，因此归档树记录的仍是内容写下的时刻，而不是 purge 运行的时刻。
- `verbatimSymlinks: true` 原样复制链接文本。默认行为会把相对目标按源树解析成绝对路径再写入，那会让归档里的每个相对符号链接都指向 purge 刚刚删掉的那个目录。
- `fs.cp` 在创建之后用显式 `chmod` 还原每个目录与文件的权限位，因此限制性的 umask 不会把归档树的权限收窄。

源目录只在复制完成之后才删除，因此中途失败的复制会把租户数据留在原处，而不是销毁它。复制也是唯一会因 `fs.cp` 拒绝的文件类型（树里的 socket 或 FIFO）而失败的步骤；该失败会到达调用方，而不是归档一棵残缺的树。

## Alternatives considered

- **把 catch 收窄到 `ENOENT`，只保留 `rename`。** 否决：它修好了沉默，没修好结果。该部署上每次 purge 都会在工作区这一步失败并把它留在宿主机上，而那正是运维想要结束的状态。
- **抛出 `EXDEV`，让运维手工归档。** 同样否决，只是把失败挪进了一份操作手册：该部署自己的 compose 文件就把归档根与租户根挂成不同卷，所以运维的每一次 purge 都需要手工介入；而在分区删除之后失败的 purge 会留下一个没有分区、工作区却还在磁盘上的已注册租户。
- **调用外部 `mv`。** 否决：该服务是没有 subprocess 接缝的插件，为移动一个目录而拉起进程，是用一种新的失败模式（`mv` 缺失或不是 GNU 版）去换 `fs.cp` 与 `fs.rm` 已经提供的行为。
- **把归档根挪进租户挂载之内，让两侧同属一个文件系统。** 作为修复方案否决：部署方把归档放在独立卷上是有意为之（留存、备份，以及一块与在线租户无关地写满的磁盘），而现有的 `archiveRoot` 回退到 `<dataRoot>/.archived` 已经覆盖了想让两者在一起的部署。把一种拓扑变成 purge 正确性的前提，会让另一种拓扑一直坏着。
- **不先 rename，一律复制。** 否决：同文件系统的 rename 是原子的，既不读取也不重写数据，而两个根常常确实同属一个文件系统（compose 文件里归档根的默认值就是租户根的兄弟目录）。rename 仍是快路径，复制是 `EXDEV` 选中的回退。
- **自己手写递归复制。** 否决：`fs.cp` 是 Node 受支持的实现，已经覆盖权限位、时间戳、符号链接处理，以及它会点名拒绝的文件类型；手写遍历会接管这些决定，却换不来本次改动需要的任何行为。

## Consequences

- purge 现在会归档位于另一个文件系统上的工作区，因此归档槽里两个根都在，租户的磁盘得以释放。各根本就同属一个文件系统的部署不受影响：它仍然走 rename 路径。
- 归档失败原因只要不是源目录不存在，purge 现在就会让 API 调用失败，而不是回答 `{ removed: true }`。租户记录保持注册；当失败发生在分区删除之后时，分区已经没了而目录还在——也就是包 README 在已知限制里记录的非事务化 purge。
- 跨设备根目录的归档不是原子的。复制与删除之间崩溃会同时留下归档与原目录树；同一租户的下一次 purge 会再归档一份。如何处置这种状态由运维决定，因为只有运维知道留下来的原目录是不是要保留的那一份。
- 复制会读写租户目录树的每一个字节，所以大工作区的 purge 耗时与体量成正比，并且短暂地需要容纳两份拷贝的空间。`tenant.admin.remove` 请求在这段时间里一直保持未完成。
- `fs.cp` 会拒绝目录树里任何位置的 socket 或 FIFO，因此含有这类文件的工作区在删除它之前无法再被 purge。这是有意的响亮失败；另一种选择是归档悄悄漏掉树的一部分。

## Testing

`packages/tenant/tenant-admin/tests/tenant-admin.spec.ts` 覆盖了这次移动的四种结局，跑的是真实文件系统，只替换 `rename` 系统调用的结果：

- `rename` 报 `EXDEV` 的工作区落到 `archiveRoot/<id>-<stamp>/workspace`，文件内容完好，原路径消失。对着修复前的源码，该用例在「原路径仍存在」这一步失败，也就是缺陷被复现。
- `rename` 报 `EACCES` 会让 `remove` 调用失败，记录仍注册、目录仍在原处。对着修复前的源码，该调用返回 `{ removed: true }`。
- 源目录本就已被删除的租户仍能完成其余 purge，因此 `ENOENT` 保持为唯一被吸收的错误码。
- 同文件系统的 purge 用例现在断言归档槽里 `data` 与 `workspace` 都在，而不只是断言槽存在。

该文件 14 个用例通过。
