# @deepseek-ai/dsh-container-k8s

Kubernetes 租户容器运行时：每个 (租户, 用户) 一个裸沙箱 Pod，以 podIP 寻址。

它实现 `container` Service Definition，因此可以在挂载租户执行世界的那一行直接替代 `@deepseek-ai/dsh-container-docker`。沙箱是裸 Pod，绝不是 Deployment 或 Job：没有东西会重建它，所以 `delete` 是完整的，也不存在任何控制器持有一份可能与本 provider 计算出的挂载集漂移的副本。

## 沙箱如何被寻址

一次性命令从不走 `kubectl exec`。Pod 运行与 docker provider 相同的 tool-exec HTTP 服务，本 provider 向 `http://<podIP>:<toolExecPort>` 发请求。由此产生两个后果，而两者正是该设计如此成形的理由：

- 宿主执行命令不需要 `pods/exec` 权限。它的 Role 只授予 `pods` 的 get/list/watch/create/delete、`pods/log` 的 get，以及 `events` 的 get/list/watch，别无其他。
- 宿主不需要容器运行时 socket。docker provider 要求把 `/var/run/docker.sock` 挂进宿主进程；本 provider 完全不需要任何宿主侧接口。

`openPty` 是唯一确实使用 `kubectl exec -i -t` 的操作，因为持久终端是 HTTP 服务唯一无法承载的东西：`POST /exec` 接收一个请求并以一个已完成结果应答，因此用它打开的会话没有 stdin、没有窗口大小，也没有投递信号的途径。provider 在宿主分配的终端下运行 `kubectl exec -i -t -n <namespace> <pod> -- <command>`，而它需要知道的关于该会话的每项事实——它跑在哪个终端会话里、哪个进程组持有该终端——都从沙箱内部读取，读取方式与其他每次调用一样，都是走 `http://<podIP>:<toolExecPort>` 的一次性命令（[`container-transport`](../container-transport)）。提供终端的部署必须为宿主 ServiceAccount 授予沙箱 namespace 中的 `pods/exec`：没有它，`openPty` 会以 API 服务器的拒绝而失败，其他所有操作不受影响。

## 挂载

每个挂载把一个宿主目录读到一个沙箱内路径。默认该目录是 `hostPath` 卷，其 `path` 为宿主目录、`mountPath` 为沙箱看到它的位置；设置 `workspaceClaim` 与 `claimRoot` 后，同一目录是某个 ReadWriteMany claim 的 `subPath`，因此无需存在任何节点路径，沙箱也不再依赖它落在哪个节点上。两种模式下沙箱内路径完全一致。

**卷以承载存储为键，从不以挂载为键。** 同一个 claim 的多个挂载共用一个 `volumes` 条目、以 `subPath` 区分；被两个卷命名为同一个 claim 则永远起不来。kubelet 按承载卷记录挂载状态，因此第二个条目会永远停在 `unmounted`，每次 pod 同步都以 `context deadline exceeded` 结束——Pod 卡在它的 init 容器之前，而没有任何事件说明原因。因此 `subPath` 属于 `volumeMounts` 条目，那也是 Kubernetes 接受它的地方。

`hostPath.type` 是 `Directory`，因此源缺失时卷挂载失败，而不是产生一个空目录。该失败从不到达沙箱：kubelet 在 init 容器启动前就拒绝该卷，Pod 停在 `Pending`，原因只出现在事件里。provider 在启动超时时读取这些事件（`readEvents`），因为一个光秃秃的 `Pending` 无法告诉运维该创建哪个路径。claim 不给出这种信号：kubelet 会把缺失的 `subPath` 建为空目录，因此 claim 模式的部署依赖租户目录树在 Pod 创建前就已存在。

一个复用沙箱镜像的 init 容器随后从内部校验每个挂载，它挂载同样的卷位置并检查挂载路径而非宿主源：当两者不同时，宿主路径在沙箱文件系统里本就不存在。这是唯一能区分「挂载正常」与「容器运行时因源缺失而建了目录」的检查。

**技能层级以一个根目录下的挂载进入沙箱，绝不用符号链接。** 案件脚本通过枚举 `/opt/data/skills` 发现技能，而每个层级挂载在 `/opt/data/skills/<kind>`：`case` 来自 `<workspaceRoot>/skills`，`user-global` 来自 `<usersRoot>/<subject>/skills`，`system` 来自 `<systemRoot>/skills`，全部只读，名称与 `skill-tier` 注册的种类一致。一个挂载只把一个源带到一个路径，因此不用链接就无法把各层级合并进一个目录，而同一个技能名可能存在于多个层级。镜像因此只创建该目录并持有一个解释器包装脚本；镜像里没有任何东西指名某个挂载路径，所以不存在会陈旧或悬空的容器内路径。

## 规格指纹

每个 Pod 携带一个 `dsh.dev/spec-fingerprint` 注解，即对已解析 Pod spec 计算的 SHA-256。每次调用时 provider 把运行中沙箱的注解与它此刻会构建出的摘要做比较：相等则收养该沙箱，不同则删除并重建。摘要与顺序无关，因此两个宿主读同一份配置会得到一致结果；顺序敏感的摘要会让每次重启都重建每个沙箱。

## 配置

`namespace` 与 `image` 必填，且在加载时校验。每次 `kubectl` 调用都限定到 `namespace`，provider 不在别处创建、读取或删除沙箱 Pod，因此一个 provider 实例在其整个存活期内只在一个 namespace 中工作。每个集群都拥有的四个 namespace（`default`、`kube-system`、`kube-public`、`kube-node-lease`）在加载时被拒绝：它们在任何集群上都是错的，且仅凭配置即可判定。属于某个集群的名字——业务 namespace、某存储组件的 namespace——被有意排除在外，因为本包无法知道它们；在这些名字上让错误取值无害的是集群：它为宿主 ServiceAccount 准备的 Role 只够到一个 namespace。其余全部可选并带 schema 默认值：`kubectlBinary`、`imagePullPolicy`、`toolExecPort`、`workDir`、`caseReadOnly`、`usersReadOnly`、`usersRoot`、`systemRoot`、`toolsRoot`、`pythonRoot`、`command`、`env`、`idleTimeoutMs`、`maxOutputBytes`、`sandboxCacheTtlMs`、`memoryLimit`、`cpuLimit`，以及 `cliTimeoutMs` / `startTimeoutMs` / `readyPollMs` 三个上限。

`caseReadOnly` 与 `usersReadOnly` 默认都为真：`/case` 是一个案件下所有用户共用的工作目录，`/global` 是该 subject 的跨案件工作目录，两者都由业务侧写入，沙箱只是读取方。让它们可写意味着一个用户的沙箱能改到同案件其他用户的输入。默认只读时，想改这两棵树的沙箱侧写入会以权限错误失败，这是有意的：产物与技能应当走业务侧的管理接口或工具。`<workspaceRoot>/users/<subject>/work`（`/workspace`）、`<workspaceRoot>/users/<subject>/sessions`（`/sessions`）与容器本地的工作目录仍然可写。

`workDir` 是执行容器的默认工作目录（默认 `/tmp/work`）：provider 在沙箱里把它挂成一个 `emptyDir` 卷。容器根文件系统只读，不是挂载点就不存在。它服务的是不带会话的调用——provider 自己的探针、宿主的工具调用——因为带会话的命令不落在这里：provider 把工作目录钉在 `/sessions/<会话 id>`，并在命令环境里给出同一个值的 `DSH_WORKDIR`。那一层在挂载进来的用户会话根上，所以同一个人的会话之间不抢同一层，容器销毁后它仍然在、会话里可以继续用。宿主的 `sandbox.workDir` 仍要与这里的取值一致：不带会话的 exec 用的就是它。按默认位置写缓存的库在沙箱里拿不到可写目录——根文件系统只读，`HOME` 是 `/root`——所以 provider 默认把 `MPLCONFIGDIR` 指向 `/tmp/matplotlib`，与 `/tmp` 那一个 `emptyDir` 同一个位置；`env` 里给出同名项时以部署的取值为准。

`workspaceRoot` 不是配置。一个 provider 实例服务所有租户，而每个租户拥有各自的工作区目录树，因此根目录从租户记录读取并传给 `sandboxMounts`；一个 provider 级取值最多只对一个租户是对的。

## 沙箱存活期

沙箱 Pod 没有控制器，因此创建它的东西也必须决定它何时结束。该决定属于容器而非宿主：每个请求都会到达容器，而宿主只看得见自己缓存的句柄；在有多个宿主副本时，宿主侧定时器会删掉另一个副本正在使用的 Pod。

`idleTimeoutMs` 就是这份预算。provider 把它作为 `DSH_TOOL_EXEC_IDLE_MS` 注入 Pod 环境，容器内的 tool-exec 服务在那么长时间没有请求到达、且没有东西正在执行时退出。比预算更长的命令绝不会被打断：进行中的请求不算空闲。退出后的容器让它的 Pod 以 `Succeeded` 结束（`restartPolicy: Never`），下一次启动会删除本 provider 持有的终态 Pod（`-l dsh.dev/managed=true` 加一个 `status.phase` 选择器）——只删终态 Pod，因为 `Running` 或 `Pending` 的 Pod 可能是另一个副本的沙箱。

无法服务的沙箱会被删除而不是留在原地。在 `startTimeoutMs` 内始终未就绪的 Pod，或已就绪但其 tool-exec 服务始终不应答的 Pod，对每个副本都不可用：收养覆盖 `Running`/`Pending` 的 Pod，留着它就会永久占住该 (租户, 用户)，而每次重试都收养同一个坏 Pod。

省略 `idleTimeoutMs` 意味着沙箱永不自行退出。`sandboxCacheTtlMs` 仍然限制宿主复用其缓存句柄的时长；在存活句柄之下退出的沙箱，代价是一次失败 exec，重试路径会据此重建。

## 交互式会话

`openPty` 在该 (租户, 用户) 已经拥有的沙箱 Pod 上返回一条活会话，首次使用时和 `exec` 一样创建 Pod。终端大小与强制终止前的宽限期由调用方给出（`ContainerPtyOptions.rows` / `cols` / `disposeGraceMs`）；这里不把二者做成配置，因为大小属于模型打开的会话，宽限期属于该会话如何被拆除。

会话身份从沙箱自己的进程表读取，而不是从 `kubectl`：`/proc` 是镜像仅有的进程表（没有 `procps`，因此没有 `ps`），所以 provider 跑一个遍历 `/proc/[0-9]*/stat` 的 POSIX shell 循环来得知会话 id 与该终端的前台进程组，并以作为程序运行的 `kill -s <signal> -- -<pgid>` 向进程组发信号。两者都是走 tool-exec 端口的一次性命令。这也正是镜像必须保持 `/proc` 可读并装有 coreutils `kill` 的原因：没有它们的沙箱根本开不出交互式会话，会在 `terminal_open` 处显式失败。

会话存活期就是沙箱的存活期。终端**不会**在 Pod 被替换后存活：因新规格指纹而被删除重建、被集群驱逐、或因空闲而退出的沙箱，会让每个会话的 CLI 进程失去它的 Pod，于是下一次写入失败、该会话的 `done` 落定，终端报告的是一个已退出的会话而不是活会话。会话的归属者是打开它的那个确切 Agent（[`tool-terminal`](../../terminal/tool-terminal)），关闭该 Agent 的会话会随之关闭容器侧会话。

## 输出上限

每条被捕获的流都带自己的上限：provider 把 `maxOutputBytes`（默认 `67108864`，即每条流 64 MiB）作为 `DSH_TOOL_EXEC_MAX_OUTPUT_BYTES` 注入 Pod 环境，容器内的 tool-exec 服务在超过该上限后继续**排空**该流——停下来会在管道写满后阻塞子进程，却丝毫不会让它的输出变小——同时只保留尾部并在结果中把该流标记为已截断。该上限必须在容器内强制，因为容器持有命令的完整原始流，而在此之前宿主的子进程能力无法约束任何东西：等到 `ctx.subprocess` 施加它自己的上限时，一次 `find /` 早已耗尽沙箱，而在 Pod 内被杀的容器会让该 Pod 停在一个不替换就无法离开的相位。

该取值只需**高于**宿主自身的每条流上限（`dsh-bash-local` 的 `maxOutputBytes`，默认 64000），这样模型看到的截断提示仍然是宿主的；它还必须高于部署方更大的预算——整文件读取，以及 `run_code` 自身的 64 MiB 载荷上限——否则那些路径本应完整读到的结果会在这里被切掉。保留尾部而非头部与宿主自己的捕获一致，因此消费者无论走哪条路看到的都一样；每个消费者自行决定如何处理被截断的流：子进程适配器把它报告为有损，文件系统适配器以 `FS_TOO_LARGE` 失败，而不是把一段尾部当作整个文件交出去。

## Model Experience

None, as the provider moves commands into a Pod and returns their stdout, stderr, and exit code; it adds no tokens, no tools, and no prompt content.

#### KV Cache effect

无直接失效；请求组装属于本 provider 从不触碰的插件。

## Known Limitations and Deferred Work

- **claim 解析是全有或全无。** `claimRoot` 必须包含每一个已配置的根目录，因此 claim 模式的部署从 claim 挂载所有层级且不留下任何 `hostPath`；无法让一个层级留在节点路径上而另一个移到 claim。
- **claim 不给出源缺失信号。** Kubernetes 会把缺失的 `subPath` 建为空目录，因此 claim 模式的启动会对着一个从未开通的租户目录树成功。本 provider 没有与 `container-docker` 的 `requireMountSources` 等价的宿主侧预检。
- **沙箱启动不做池化。** 冷 Pod 要花几秒，而 docker 容器只要几毫秒；自行因空闲退出的沙箱意味着繁忙租户在下一轮次再次支付该代价。预热 Ready 池需要一个在会话之间持有这些 Pod 的归属者。
- **未被复用的沙箱只在终态时被回收。** 启动清扫删除本 provider 的 `Succeeded` 与 `Failed` Pod，而 `Running` 的 Pod 会在其 (租户, 用户) 下次被使用时再次被收养——若它无法服务也会在那时被删除。一个 (租户, 用户) 永不再用的运行中 Pod 会一直留着，直到运维按标签删除它，因为删除存活 Pod 会让一个副本毁掉另一个副本的沙箱。
- **只设 limits，不设 requests；limits 会不会变成预留量由集群决定。** `memoryLimit` 与 `cpuLimit` 落成沙箱容器上的 `limits`，这里有意不声明 `requests`：多个 (租户, 用户) 的沙箱是逐个突发起来的，声明等额 requests 会把内存从节点上永久预留出去。但**集群可以把 limits 回填成 requests**，验收集群（k8s v1.28.15）就是这样——用一个只写 `limits.memory=1Gi` 的合成 Pod 实测，落库后 `requests.memory` 被填成同值（该命名空间没有 LimitRange，也没有变更型 webhook，`managedFields` 为空）。预留量决定能否调度：该节点 allocatable 只有 4 核（已请求 1150m），所以 `cpuLimit: 4` 会让沙箱 Pod 永远因 `Insufficient cpu` 停在 Pending，验收部署只配 `memoryLimit`。调这两个值之前先确认节点给得起它们换来的预留量。
- **输出上限覆盖的是捕获，不是命令自身的内存。** `maxOutputBytes` 按流生效，因此同时写两条流的命令可以留存该值的两倍，而一个自身就吃掉容器全部内存的命令（比如在内存里排序大文件）仍能拖垮沙箱：该上限只是通过**捕获**阻止沙箱无限增长。命令自身的内存由 `memoryLimit` 上界（CPU 由 `cpuLimit`），越界时被 OOM killer 杀掉的是这个沙箱自己的 cgroup，而不是节点上别的负载——验收集群上实测容器内 `/sys/fs/cgroup/memory.max` 等于配置值（配 `6Gi` 时读回 `6442450944`），即这个界限落在内核上而不只是 API 对象上。**不配 `memoryLimit` 的部署里沙箱没有内存上界**：Pod 落在 BestEffort，可以一路吃到节点内存耗尽，而内核在那一刻按 `oom_score_adj` 挑受害者——被挑中的可能是节点上任何与它无关的进程。生产部署必须配它。
- **事件只在启动超时时读取。** 启动后失败的沙箱，其容器状态出现在失败消息里，但解释它的事件不在其中。
- **网络是集群的。** docker provider 的 `tenant.network: none` 没有对应物：未安装 NetworkPolicy 控制器，因此沙箱能到达集群能到达的一切。
- **交互式会话随其沙箱一起消亡。** 因新规格指纹被替换、被驱逐或因空闲而退出的 Pod 会带走其中每个终端会话；该 (租户, 用户) 的会话必须重新打开。无法让会话跨越 Pod 替换存活，因为终端住在当时附着到旧 Pod 的那个 CLI 进程里。
- **`pods/exec` 是终端功能的部署要求。** 没有它的宿主 Role 仍能运行每一条一次性命令，只会让 `terminal_open` 失败——这是有意的：`pods/exec` 是在该 namespace 内执行集群范围代码，不提供终端的部署不应授予它。
- **没有终端 resize。** `openPty` 在会话打开时固定窗口大小，因此为 40×160 打开的终端会渲染一个在启动时读取该大小的程序。放大或缩小既有终端需要对 `container` 增加一个操作，以及一条通往运行时 CLI 的信号路径，两者目前都没有调用方。
- **会话的探测是针对同一沙箱的一次性命令。** tool-exec 服务在会话中途停止应答的沙箱，会报告探测失败而不是给出错误的前台进程组；该会话随后按自己的截止时间落定。
