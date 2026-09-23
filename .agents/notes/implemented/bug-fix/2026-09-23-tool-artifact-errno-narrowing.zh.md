# Agent Note: 产物工具只吸收 ENOENT，绝不把文件系统失败当成不存在

Status: implemented

[English](2026-09-23-tool-artifact-errno-narrowing.md) | 中文

## Problem

`@deepseek-ai/dsh-tool-artifact` 用三个结论回答了三次文件系统失败，而模型无法把它们与真相区分开。`resolveSource` 把 `realpath` 的每一次拒绝都改写成 `file_path "/workspace/report.docx" does not exist`，于是宿主拒绝读取的路径——`EACCES`、`ELOOP`、`ENAMETOOLONG`——得到的回答是 `does not exist`。`listPublished` 用 `readdir(...).catch(() => [])` 读主体的产物目录、用 `stat(...).catch(() => undefined)` 检查每个条目，于是读不了的产物目录回答 `Nothing has been delivered to this user yet.`，检查不了的条目从模型当作完整清单来读的列表里消失了。

这正是[租户 purge](2026-09-23-tenant-purge-cross-device-archive.md)与[沙箱挂载源预检](2026-09-23-sandbox-mount-source-preflight.md)各自从一侧指出的同一类缺陷：把真实失败汇报成一个具体的、错误的结论，违背「缺失的指称对象绝不静默跳过」「故障要响亮失败」这两条规则。purge 汇报「没有东西可归档」，把租户工作区留在磁盘上；预检什么都没汇报，挂载了一个空目录。这里的结论是「文件不存在」与「你什么都没交付过」——而读者是模型，它会把这些结论当作事实转述给用户。

不存在与读失败是两种不同的回答，它们的差别以不同文本到达模型：`entries: []` 渲染成 `Nothing has been delivered to this user yet.`，而短列表渲染成交付文件数与每条一行。被告知「什么都没有」的模型会向用户报告空库；被告知「一个文件」、本应被告知「两个」的模型会报告一个少了其中一个的完整库。

## Decision

一个谓词 `isENOENT`，每处只吸收一个错误码，并各自给出使该码在此处只可能意味着这一件事的可达性论证。

**`resolveSource`。** `candidate` 是挂载根——上面刚由 `realpath` 解析过，因此它存在——与模型自己路径的拼接，所以除了「那条路径在不在」之外，它没有任何未知部分：`ENOENT` 就是不存在，并保留那条给出容器路径的消息。其余错误码原样到达调用方，errno、消息与出错的系统调用全都保留。挂载根自己的 `realpath` 本来就是原样抛出的；两次调用现在对称。

**`listPublished` 的 `readdir`。** 主体的产物目录在第一次发布之前并不存在——那是正常初态而不是失败——而刚列出它的那次 `readdir` 命名的子目录，可能在递归到达它之前就没了。两种情况下 `ENOENT` 都是空列表。`EACCES`、`EIO`、`ENOTDIR` 意味着这次读取因为不存在之外的原因失败了，它们到达调用方。

**`listPublished` 的 `stat`。** 名字来自该目录自己的 `readdir`，所以那个条目片刻之前确实存在：`ENOENT` 是一次并发删除，跳过一个已经不存在的文件是准确的。其余错误码到达调用方，因为丢弃该条目会在不声不响中缩短列表。

**`publishInto` 的 `finally`。** 暂存文件的尽力删除保留它的 catch，并在代码里写明理由：成功路径已经把 `staging` 重命名成 `destination`，所以 `ENOENT` 正是已发布产物在这里通常报出的码；任何其他错误码最多留下一个点号开头的 `.part` 文件，没有读者会打开它，也没有任何列表会报告它。清理不可能把失败报成成功——`try` 会先抛出它自己的错误——而让清理失败从 `finally` 逸出，会把一个已经返回的目标路径换成错误，把已交付的产物报成未交付。

本模块通过 `import { promises as fs } from 'node:fs'` 上的 `fs.realpath(...)` 调用文件系统，而不是从 `node:fs/promises` 具名导入。Node 为内建模块提供的 ESM 门面会对其具名导出做快照，所以对 `node:fs/promises` 做 `vi.spyOn` 永远到不了用具名导入的模块，这些测试需要的 errno 接缝也就不可达。`dsh-tenant-admin` 读文件系统用的是同一种写法。

## Alternatives considered

- **删掉这些 catch，让 `ENOENT` 也抛出。** 否决：在这三处，不存在都是正常状态——没有交付过的主体没有那个目录，被成功重命名的暂存文件已经不在了。抛出它会让正确的调用失败。
- **保留全吞的 catch，把失败汇报到别处。** 否决：本插件没有 logger，它对模型的唯一通道就是工具结果。没人看的告警会把错误结论原样留在那里，那是缺陷本身，而不是对它的缓解。
- **把非 `ENOENT` 的失败包装成一条给出容器路径的消息。** 否决：为了仍然有用，包装必须内嵌原始消息，于是它本想隐藏的宿主路径照样到达，而且包装会丢掉原始错误对象与它的 `code`。原样抛出正是 `dsh-tenant-admin` 的 `moveIntoArchive` 对不吸收的错误码所做的事。
- **把 `ENOTDIR` 也当作不存在。** 否决：某个路径分量不是目录，并不是路径不存在。在 `readdir` 这一处，它意味着主体自己的产物路径现在是个文件——一个运维必须看到的状态；在 `resolveSource` 这一处，它意味着模型把文件当目录来寻址，而该失败恰好准确说明了这一点。
- **返回部分列表，并给出被跳过的条数。** 否决：模型无法核对一个含义为「本部署检查不了的条目」的数字，于是它会报告一个自己没有任何理由怀疑的计数。本工具的回答就是「该主体交付了什么」，不是这个回答的列表要失败。
- **把清理的 catch 收窄到 `ENOENT`，其余抛出。** 否决：从 `finally` 抛出会替换掉发布已经返回的目标路径，于是一次已经交付文件的调用会以错误作答且没有交付标签——把成功报成失败，是从另一个方向犯的同一类错误结论。

## Consequences

- 产物目录读不了的部署，现在 `artifact_list` 会失败，而不是报告一个空库；条目检查不了也会失败，而不是报告一个更短的列表。目录可读时什么都不变。
- 源文件被宿主拒绝解析的发布，现在以原始 Node 错误失败，该错误给出宿主路径与出错的系统调用。这是模型本来看不到的部署目录结构；它无法对其采取行动，而替代方案要付出 errno 与错误对象的代价。
- 清理失败会在产物目录里留下一个 `.<stamp>.<uuid>.part` 文件。没有列表会报告它，因为 `artifact_list` 跳过点号开头的名字；也没有读者能到达它，因为没有任何东西引用它；它会占用磁盘直到运维删除。
- 发布与列表工具现在区分「没有发布过」与「读不了」，因此部署故障会经由模型浮到用户面前，而不是表现为一个空库。

## Testing

`packages/tenant/tool-artifact/tests/artifact-tools.spec.ts` 在真实临时部署之上启动本插件——`ToolRuntime`、主体的 `/workspace` 挂载、以及已鉴权的（案件，主体）作用域——并通过 spy `node:fs` 的 promise 对象一次替换一个系统调用。9 个用例通过。

- 对源文件报 `EACCES` 的 `realpath` 让发布失败，结果里带 `EACCES`，且不带 `does not exist`。对修复前的源码，同一个用例收到 `Error: file_path "/workspace/report.docx" does not exist`——缺陷原样复现。
- 对产物目录报 `EACCES` 的 `readdir` 让 `artifact_list` 失败；对修复前的源码，同一次调用以 `isError: false` 与 `entries: []` 解决，渲染成 `Nothing has been delivered to this user yet.`。
- 对某个已发布条目报 `EACCES` 的 `stat` 让 `artifact_list` 失败；对修复前的源码，同一次调用以 `isError: false` 解决，该条目被静默丢弃。
- 对某个已发布条目报 `ENOENT` 的 `stat` 仍然跳过它，而尚不存在的产物目录仍然是空列表：这两个被吸收的错误码被钉死为「被吸收」，因此上面的可达性论证是被执行过的，而不是被断言的。
- 对暂存文件报 `EACCES` 的 `unlink` 仍然交付该产物：发布以它的路径与交付标签解决。被否决的替代方案也用同样方式实测过——把清理的 catch 换成裸的 `await fs.unlink(staging)` 会让同一个用例失败，那是一次已交付的产物被报成未交付。
- `packages/tenant/tool-artifact/tests/artifact-store.spec.ts` 保持其 18 个用例；本包共 27 个通过。
- `tsc -b tsconfig.host.json` 干净，而该程序包含 `packages/*/*/tests/**/*.ts`，因此新套件是被类型检查的。

`src/index.ts` 在本次改动之前没有任何自己的测试；现在测得 83.87% 语句与 61.76% 分支，仍低于仓库的每文件 100% 覆盖率门槛。剩余未覆盖的行是挂载逃逸拒绝（需要本机 Windows 拒绝创建的符号链接）、交付名耗尽循环，以及超限与分页渲染分支。该缺口不在本次改动中关闭。

## Related

- [租户 purge 跨文件系统归档，而不是汇报一次从未发生的移动](2026-09-23-tenant-purge-cross-device-archive.md)——归档路径上的同一类缺陷：被吞掉的 `EXDEV` 被读成目录不存在。
- [沙箱绑定挂载源由 tenant-admin 预置，启动前缺失即失败](2026-09-23-sandbox-mount-source-preflight.md)——同一族的缺失指称对象一侧。
