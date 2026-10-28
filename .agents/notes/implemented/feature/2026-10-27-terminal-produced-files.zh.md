# Agent Note: 终端命令报告它产出的文件

Status: implemented

[English](2026-10-27-terminal-produced-files.md) | 中文

## Problem

模型用 `bash` 跑 python-docx 生成 `.docx` 时，产物从来没有被识别出来。轮次的产出文件行和部署侧的文件统计都只读工具对自身的声明：修改工具在 diff 卡片或 `kind` 为 `edit` 的通用卡片上声明的 `locations`。命令创建的文件不在其中任何一处，于是这次运行把报告写进了磁盘，而所有产出文件视图都是空的。

信息其实存在——容器知道什么变了——但没有任何通道承载它：bash 工具自身的结果文本是面向模型的，而调用态的呈现器在命令执行之前就已运行。

## Decision

四处改动，一条通道：

- `@deepseek-ai/dsh-tools` 的呈现层增加该字段：`TerminalCallView` 与 `TerminalResultView` 携带可选的 `produced: FileLocation[]`，含义是「这条命令创建或修改了这些文件」，与 `locations` 区分——后者还包含命令仅仅读过的文件。调用态的呈现器无法观测执行，因此终端调用视图通常省略它；完成态的结果视图承载这次运行实际写入的内容。
- `@deepseek-ai/dsh-subprocess-container` 按容器自己的时钟观测写入效果。在会话内命令之前创建一个标记文件（`/tmp/.dsh-produce-<uuid>`）；命令落定后，一次有界的 `sh -c` 列出会话目录下比该标记更新的普通文件，并删除标记。`SubprocessOutcome.produced` 以执行器自身的路径写法承载这些路径，`ShellRunResult.produced` 原样重导出。
- `@deepseek-ai/dsh-tool-bash` 把它们放到卡片上：`presentationMeta` 把 `{ produced: [{ path }] }` 投影到持久化的 `tool/result` 元数据上，`presentResult` 再还原回来，因此终端卡片在实时与回放路径上都带着这些路径。
- `@deepseek-ai/dsh-client-ui-deliverables` 把成功调用的产出文件折叠进 `DeliverablesTurnData`，与 diff 卡片同等地位，按首见顺序去重。

这些否定条件也是决定的一部分。失败的调用不贡献任何条目。提供方无法归属到某个会话的命令（托管环境里没有 `DSH_SESSION_ID`）完全不做观测，因此宿主探测与可执行文件查找不付任何代价。观测失败——容器不可达、标记创建不了、扫描以非零退出或超时——退化为「没有产出」，绝不使命令本身失败。路径保持容器绝对的 `/sessions/<id>/…` 写法，与 `@deepseek-ai/dsh-fs-container` 的 `displayPath` 已产出的形式一致，因此同一个路径在两个能力里指同一个文件。

面向模型的文本、工具参数与执行器的结果渲染都保持不变：这份文件列表只抵达终端卡片。

## Alternatives considered

- **命令结束后遍历宿主侧会话目录副本**：否决——会话目录可能落在宿主读不到的存储上，而且用宿主时钟对新近容器写入的文件做 `-newer` 比较是把两个时钟混在一起。
- **从命令行或 stdout 里读写入路径**：否决——`python make.py` 不会说出它写了什么，从输出里找文件名是猜测。
- **给命令套一层追踪**（`strace`、fanotify、shell 的 `PROMPT_COMMAND`）：否决——在这些容器基质里不可用或需要特权，而且包装层会改变模型要求执行的那条命令本身。
- **把产出路径持久化为新的会话事件**：否决——这份列表属于呈现层，回放时从 `tool/result` 元数据重算即可，为新事件会让每条日志都变长，只为了一行 UI。
- **在面向模型的结果文本里列出文件**：否决——为了服务 UI 而改变每次 bash 调用的上下文与 KV 缓存稳定性。
- **让 `dsh-tool-bash-persistent` 报告同样内容**：暂缓——持久 shell 没有按命令的落定点，不存在「某一条命令的写入已知」的时刻。

## Consequences

- 用命令生成文档的轮次现在会把它列出来，产出文件行与文件统计因此与磁盘一致。
- 每条会话内的前台命令多花两次 `containerRuntime.exec`：之前的 `touch`，之后的 `sh -c`（find 加删除标记）。后台启动也付这两次代价并丢弃报告，因为启动没有可挂载的落定点。
- 扫描只覆盖会话目录，且 `-newer` 依赖文件系统时间戳粒度：在粒度较粗的卷上，与标记落在同一时间片内的改写会漏报。这类部署常用的会话存储正是 `emptyDir`。
- 不观测写入效果的执行器——本地与 pwsh 执行器——什么都不报告，因此这一行列出的内容取决于部署组装的执行器。
- `presentationMeta` 不能返回 `undefined`（投影必须是无损 JSON），所以 `createSuccessResult` 现在会丢弃没有任何成员的投影，而不是持久化 `meta: {}`。对某个结果没有呈现事实的工具返回 `{}`，而不带产出元数据的已记录结果逐字节不变。

## Testing

`packages/tenant/subprocess-container/tests/container.spec.ts` 证明这次观测：会话内命令只报告扫描列出的内容；标记创建不了或探测不到时禁用报告且不运行扫描；扫描被拒绝或以非零退出时什么都不报告；被截断的扫描丢掉它的首行残片；没有会话身份的命令完全不运行观测 exec；exec 失败仍然结算扫描（只为删除标记）并以原错误拒绝。`packages/shell/tool-bash/tests/tools.spec.ts` 证明规范值、持久化元数据与呈现器重建出的卡片，并证明不报告写入的执行器在任何一处都不会新增 `produced` 字段。`packages/client/ui-deliverables/tests/produced-files.client.spec.tsx` 证明这次折叠：成功的终端调用在两种卡片状态下都按首见顺序各贡献一次路径，失败的调用不贡献任何条目，没有任何写入的命令不新增条目。`packages/core/tools/tests/tools.spec.ts` 证明没有成员的投影不会持久化 `meta`。