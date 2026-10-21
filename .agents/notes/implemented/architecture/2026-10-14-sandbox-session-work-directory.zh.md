# Agent Note：让每个会话在挂载进来的案件工作区上有一层自己的工作目录

Status: implemented

[English](2026-10-14-sandbox-session-work-directory.md) | 中文

> 沙箱里的命令跑在容器本地的 `workDir` 上——一个在同一个人的所有会话之间共享、又随容器一起丢弃的 `emptyDir`——所以同一个人的两个会话抢同一层目录，而会话的产出随它的沙箱一起消失。

## Problem

两个容器 provider 都把 `workDir` 建成一个 `emptyDir`，并把它当作 `tool-exec` 容器的默认工作目录。一个沙箱服务一对 `(租户, 用户)`，并在该用户的所有会话之间复用，因此那一层目录同时属于这些会话：并发会话互相覆盖对方的产出，写进去的东西也活不过容器。沙箱会在规格变化时被替换、会被节点驱逐、也会在空闲 watchdog 退出时消失。挂载进来的案件工作区 `/workspace` 本来就是持久的，但没有任何东西告诉一个会话其中哪一层是它自己的：报告类技能去读 `DSH_WORKDIR`，而整个仓库里没有任何包定义过这个变量。

## Decision

- 会话的命令跑在 `/sessions/<会话 id>`：每个会话一层目录，位于承载该主体会话目录的那个挂载之下，因此在 claim 上而不是在容器里。
- provider 在该会话的第一条命令上建出它，按 `(租户, 用户, 会话)` 只建一次，用 `mkdir -p`。那一层可能已经存在——同一个用户的另一个沙箱、或更早一次宿主启动建的——而 `mkdir -p` 对两种情况都对。工作区是 claim，所以目录比建它的沙箱活得久。
- 会话工作目录盖过调用方要求的工作目录：调用方手上的是它自己那台机器上的路径，而沙箱里的路径由挂载表决定。不带会话的 exec 保持调用方给的工作目录、因而保持容器默认值——provider 自己的探针与宿主的工具调用就是这种。
- `DSH_WORKDIR` 在那条命令的环境里载着同一个绝对路径，技能与模型因此可以直接认领自己往哪写，而不需要自己推导。
- 文件面按同一条规则解析：`dsh-fs-container` 把相对路径放进调用会话自己的目录，盖掉调用方传进来的 `cwd`。命令从一开始就走这个覆盖，文件工具却没有，于是会话的 `write`/`edit` 落进容器本地的 `workDir`——正是这份 note 要离开的那层共享且会被丢弃的目录——而它的命令写的是会话目录。`sandboxSessionDirOf(session)` 是同一个推导，输入换成文件 provider 手上直接有的会话 id；没有会话在作用域里时，配置的 `root` 仍然生效。
- 会话 id 会成为一个路径分量，所以只接受普通目录名；`sandboxSessionDir` 拒绝其余一切，包括会让它变成 `mkdir` 参数的前导短横线。被拒绝的 id 让命令留在调用方的工作目录里，而不是在工作区之外造出什么。
- `SANDBOX_WORKSPACE_MOUNT`、`SANDBOX_WORKDIR_ENV` 与 `sandboxSessionDir()` 都放在 `@deepseek-ai/dsh-tenant`，两个 provider 都用它们：挂载点只有一个名字，推导只有一份实现。
- 模型被告知的工作区就是这一层。`sandboxPolicy.resolve()` 用会话 cwd 推出 `workspace-write` 的根，而 `sandbox:policy` 那段提示把这个根写成「会话工作区」——所以默认值还是容器本地 `workDir` 时，模型照字面把成品写进 `/tmp/work`，还报告说写好了，而会话目录——以及供业务侧拉成品的那条文件面——一直是空的。租户栈现在把模板 `/sessions/{sessionId}` 作为业务面网关的默认 `cwd`（网关替入建出的会话 id，因此恢复的会话与重建的预分配 id 落在同一层），并给 `createProjectDirectory: false`：宿主上没有这个路径，它由 provider 在会话第一条命令时建出。

## Alternatives considered

- **保留容器本地目录，让会话在结束时把产出搬出来。** 否决：持久化于是变成模型必须记得做的一步，而这一步恰恰在沙箱将死时失败。
- **把会话目录收到平台自有的名字（如 `sessions/`）下。** 运维方否决：直接放在工作区下面的一层会话目录，才是案件负责人预期看到的样子。后来被反转——[One file surface over the five scopes a subject's work lives in](2026-10-21-five-scope-file-surface.md) 给会话目录独立的挂载与独立的名字。
- **在创建会话时就建目录。** 暂不采纳：租户宿主没有会话创建钩子，这样必须新增一个租户插件；而 provider 从第一条命令的环境里就能读到会话 id，效果上是同一个时刻。
- **在宿主文件系统上建它而不是在沙箱里建。** 否决：provider 的主体是集群，而 `/workspace` 已经由沙箱自己拥有。
- **把交互式终端也搬进会话目录。** 未采纳：终端会话不是这次要关掉的问题。

## Consequences

- 中间产物现在默认会留下来。想要一次性空间的会话仍然有容器自己的 `/tmp`；没有任何东西替它删。
- 会话按相对路径写文件与按相对路径跑命令指的是同一个文件，因为两者都在会话目录里解析。文件面跟上这条覆盖之前，它们指的是两个不同的文件：模型用文件工具写完一份报告，再用自己的 `cat` 读同一个路径会读到空。
- 模型被告知的工作区也是这一层，因此成品就写在业务侧读取的地方：模型用的相对路径、它可能自己推的绝对路径 `/sessions/<id>/…`、以及文件面服务的那条路径，是同一个文件。在会话 cwd 传到网关之前，提示里写的是容器本地的 `workDir`，照它写的模型产出的是会话自己的 `bash` 都看不到的文件。
- 会话目录现在有独立的挂载：一个主体的会话目录是 `<workspaceRoot>/users/<subject>/sessions/`，挂到 `/sessions`，因此露出该主体的工作目录不再连他的会话一起露出（[理由](2026-10-21-five-scope-file-surface.md)）。
- 每个会话都会留下自己那层目录，所以 `/workspace` 会按会话数增长。何时清理属于业务侧的决定，不属于 provider。
- 这反转了一条已写下的决定：container-k8s README 曾说模型按相对路径写出的东西必须随沙箱销毁而消失。现在它与被接受的行为正好相反，而这份 note 就是这次反转的记录。
- 会话的第一条命令多付一次往返（`mkdir -p`）。代价按会话计，不按命令计。
- 会话的常驻终端仍留在容器的默认目录，而该会话的命令跑在会话目录里，所以在同一个会话里，同一个相对路径经终端写与经命令写会落在两个地方。终端一并搬迁未被采纳。
- 把工作目录写死的技能会废掉这个机制：发到验收部署上的报告技能曾指示模型 `export DSH_WORKDIR=/workspace`，那会盖掉平台的值，把所有会话打回共享根。它现在不再动这个变量，改为核对解析出来的目录带着本会话自己的名字。技能文本因此也是这个行为的一部分，尽管它不发在仓库里。
- 交叉引用：这次在其下加一层的挂载表见 [One `.dsh` root and one directory list for a tenant](2026-10-13-single-tenant-root-and-directory-list.md)，避免会话产出把节点拖垮的上界见 [Bound the sandbox container's memory and CPU](2026-10-14-sandbox-resource-limits.md)。

### Verification

- `packages/tenant/tenant/tests/layout.spec.ts` 钉住推导：一个会话 id 得到 `/sessions/<id>`，不带会话的 exec 什么也得不到，而 `../../etc`、`.`、`..`、`a/b`、空串、`session 7`、`-p` 全部被拒。
- `packages/tenant/container-k8s/tests/runtime.spec.ts` 与 `packages/tenant/container-docker/tests/docker.spec.ts` 读 provider 真正发出去的请求：会话的第一条命令之前先有 `mkdir -p /sessions/<id>`，该命令以那个目录为 `cwd`、并以同一个值作为 `DSH_WORKDIR`，同一会话的第二条命令不再建，另一个会话会建，而不带会话的 exec 保持调用方的 `cwd` 与环境。
- `packages/tenant/fs-container/tests/container.spec.ts` 在有会话在作用域里时解析一个相对路径：即使调用方传的是容器本地的 workDir，它也落进 `/sessions/<id>`；绝对路径保持绝对；没有会话时——完全没有、注册表已销毁、或 id 不能当目录名——依次退回调用方的 `cwd` 与配置的 `root`。它还钉住写入会建出自己点名的父目录。
- `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts` 把 `{sessionId}` 默认目录按会话展开成一层一层的目录，并在宿主不拥有它时不建它；`packages/tenant/tenant-app/tests/app.spec.ts` 钉住交出 `/sessions/{sessionId}` 与 `createProjectDirectory: false` 的 `api-gateway` 那一行。
- tenant、container-k8s、container-docker 三个包的 165 个测试通过，`pnpm run typecheck` 干净。