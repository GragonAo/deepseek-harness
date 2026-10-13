# Agent Note: 租户的终端是它自己沙箱里的会话

Status: implemented

[English](2026-10-08-tenant-terminal-in-the-container-sandbox.md) | 中文

> `ctx.containerRuntime` 多了一个交互式操作 `openPty`：它由 `container-transport` 在一只宿主分配的真实终端下实现一次，两个 provider 共用；新的租户包 `dsh-terminal-container` 把它注册成 `ctx.terminals` 的 backend，于是多租户部署里的 `tool-terminal` 与 `tool-bash-persistent` 拿到的是租户自己沙箱里的持久终端。

## 问题

多租户栈每个 (租户, 用户) 只有一条执行面：一个用 `POST /exec` 回答「一条已完成命令」的沙箱容器。`packages/tenant/tenant-app/src/spine.ts` 既没挂 `tool-terminal`，也没挂 `tool-bash-persistent`，而且挂不上：这两个消费者都经 `ctx.terminals` 触达模型，而该 seam 唯一已交付的 provider `dsh-terminal-bash` 在宿主进程上开 PTY。把它挂进租户栈，等于让每个租户的 shell 落在共享宿主上——脱离了这个栈其余部分的隔离前提；而 `bash` 的全部价值（一条 shell 跨多条命令复用，因此 `cd`、导出的环境变量、激活过的 virtualenv 都还在）恰恰需要一条活得比单条命令更久的 shell。

`ctx.terminals` 是一条本来就有 Consumer（`tool-terminal` 六个工具）与 Definition（`packages/terminal/terminal`）的 capability seam，缺的只是租户形态的 Provider。这个 Provider 必须守住该 seam 的核心承诺：每个操作都绑定**发起调用的那个精确 Agent**，因此一个 Agent 永远读不到、信号不到、也关不掉另一个 Agent 的终端。租户形态不得削弱它——沙箱是按 (租户, 成员) 复用的，同一成员的多个 Agent 落到同一个沙箱是常态，只有会话注册表能区分他们的终端。

当时的阻塞事实是容器运行时只提供那一条一次性 `exec`。持久终端需要双向 stdin/stdout、窗口大小、以及信号投递，而请求/响应式的 `POST /exec` 一样都不带。

## 决策

**交互式操作归 Service Definition。** `packages/tenant/container/src/index.ts` 在 `exec` 旁边新增 `openPty(options): Promise<ContainerPtySession>`，并给出 `ContainerPtyOptions`（`command`、`args`、`rows`、`cols`、`maxOutputBytes`、`disposeGraceMs`、`signal`）与句柄（`pid`、`done`、`read`、`write`、`foreground`、`signal`、`close`）。它属于 Definition，因为这是每个 provider 都必须给出、任何 Consumer 都无法伪造的后端知识：谁能把终端附加到沙箱上，谁才知道怎么做，而两个现有 provider 都回答同一个运行时选择。provider 自己**不再**新增 PTY 形状的公开 API，终端 provider 也学不到任何一个运行时 CLI 旗标。

`openPty` 刻意不带 `cwd` 与 `env`：这两样是运行时 CLI 自己的旗标（`docker exec -w/-e` 在 `kubectl exec` 没有对应物），把某个 provider 的旗标放进定义，就等于让它们成为所有 provider 的义务。需要工作目录的调用方自己用 `sh -c` 包住命令——这正是新 provider 的做法。

**两个 provider 通过同一份实现落地。** `container-transport` 补上它 README 早已预告的第三种传输形态：`ptyRunner(binary)` 在宿主上分配一只真实终端（`node-pty`）并在其下运行运行时 CLI 的 `exec -i -t`，而 `openContainerPty` 把会话只实现一次——写握手、从沙箱自己的 `/proc` 读出会话号与前台进程组、保留有界的输出尾部、结束时 `SIGTERM` → `disposeGraceMs` → `SIGKILL` 并复核进程组确实没了。`container-k8s` 提供 `['-n', namespace, 'exec', '-i', '-t', pod, '--', …]`，`container-docker` 提供 `['exec', '-i', '-t', container, …]`，各自再传一个绑定到它已解析沙箱的一次性 `exec` 闭包。真实本地终端不是偏好：管道 stdin 上的 `docker exec -i -t` 会被 Docker CLI 自己的 `CheckTty` 拒绝，因此分配不出终端的主机在启动阶段就响亮失败，而不是悄悄退回一条没有 TTY 的会话。

**backend 由新的租户包提供。** `packages/tenant/terminal-container`（`@deepseek-ai/dsh-terminal-container`）在 `ctx.containerRuntime.openPty` 之上实现 `ctx.terminals` 的 backend 契约，默认注册类型 `shell`（`backendType` 是经过校验的配置）。它打开 `/bin/sh -c '<骨架>' <shellPath> <shellArgs…>`：骨架先进入会话的 `cwd`（进不去就打印原因并以 126 退出），并把 `TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`、`DSH_SHELL=1`、`DSH_SESSION_ID=<会话所属 Agent>`、`DSH_PTY_SESSION_ID=<终端会话 id>` 交给 shell，然后 `exec` 成配置的 shell；会话其余部分由它负责：有界历史与按行分页、下面的落地规则、以及收尾。

**落地条件是静默加一次探测，而且结论有名字。** 被附加的交互式 shell 不会报告命令边界，因此 `send` 以四种结论之一落地：`stdin_read`（安静满 `idleSilenceMs`，且仍有活着的进程组占着终端）、`inferred_idle`（安静，但没有进程组占着它）、`session_exit`、`timeout`。每次 send 至多一次 `foreground()` 探测，绝不按轮询节奏去打沙箱。这刻意不是「静默即结束」：`tool-bash-persistent` 只在 `stdin_read` 时提前返回，把安静的一次 send 判成 idle 会让它 25 ms 的轮询循环用探测往返猛敲沙箱，也会在命令还没结束时报告它已经结束。

**会话的生命周期就是沙箱的，而且结束是可见的。** 沙箱被替换、被驱逐或按空闲退出后，终端不会保留：容器侧的 `done` 落地，会话的 `status()` 报出已退出，下一次 `send` 以 `session_exit` 落地而不是挂住。关闭是复核过的而不是假定：给前台进程组 `SIGTERM`、一段宽限期、再 `SIGKILL`，最后重新探测——还有进程组活着就让这次关闭失败。

**装配是追加的，配置留在 `Config` 里。** `tenant-app/src/spine.ts` 在既有行之后新增四行（`terminal`、`terminal-container`、`tool-terminal`、`tool-bash-persistent`），`deps.ts`、`package.json` 与各处 tsconfig 同步更新。

**本地 CLI runner 对「子进程不再读 stdin」按正常完成结算。** `container-transport` 的 `cliRunner` 是两个 provider 触达运行时二进制的接缝：子进程关掉自己的输入所导致的 stdin 写入失败算一次已完成的调用——退出码与已捕获输出照旧，宿主进程上也不留下未处理流错误。这一类的码与沙箱内 `/exec` 服务已经点名的是同一组（`EPIPE`、libuv 的 `EOF`、`ECONNRESET`，一个 `ReadonlySet` 加一个谓词），理由也相同：经 stdin 传的命令就是 `kubectl create -f -`，把「管道写不完」报成失败会让调用方去重试一条已经成功的创建。其余写入错误一律以指名该二进制的错误拒绝。而那条流无人接管时并不是一次普通 rejection：未处理流错误会把宿主进程带走。

## 考虑过的替代方案

- **在容器内的 tool-exec 服务里放一条常驻 shell。** 否决：`POST /exec` 是请求/响应，服务没有回到宿主的双向通道，报不出窗口大小，也没有办法把 `SIGINT` 投给正在跑的子进程。它还会让那个服务成为会话状态的第二个所有者——会话 id、历史缓冲、进程组记账会同时存在于两处，宿主眼里的「会话」只是容器里那个的代理。
- **让终端 provider 自己去调 `kubectl`/`docker`。** 否决：这制造了后端知识的第二个所有者。provider 就得知道命名空间、Pod 名、容器名与旗标拼法——全都是 `container-k8s` 与 `container-docker` 已经拥有的东西——而且每加一个后端，都要在一个根本不以后端为主题的包里加一条分支。这也正是新 provider 只是一层薄薄的会话层、而不是重写一遍运行时的唯一原因。
- **在一次性的 `exec` 上伪造 PTY（`script`、`socat`、`unbuffer`）。** 否决：沙箱交回来的仍然是一个已完成的结果，因此会话在两条命令之间没有 stdin、没有信号、也没有窗口大小；它还要求镜像恰好带上了某个二进制。
- **用管道 stdio 跑 `docker exec -i -t`，不在宿主上分配终端。** 是工具否决的，不是我们：stdin 不是终端时 Docker CLI 会拒绝 `-t`（`CheckTty`）。不带 `-t` 的会话没有作业控制，没有可投递信号的前台进程组，shell 也中断不了。
- **终端跑在宿主进程里，需要时把文件拷进沙箱。** 否决：它把租户的 shell 放在租户沙箱之外——正是这个栈存在的理由（隔离）——而且 `cd` 会解析到宿主路径上。
- **把租户终端做成 `tool-terminal` 的一项配置，而不是一个 provider。** 否决：`tool-terminal` 是这条 seam 的 Consumer，保持与后端无关；让它知道沙箱，等于把后端知识搬进工具 schema，并让 `tool-bash-persistent` 与以后每一个终端消费者重新学一遍。
- **用镜像从 `PATH` 解析到的 `kill` 程序投递进程组信号。** 实测否决：负操作数才是「对进程组」的写法，而 procps-ng 的 `kill`（Debian bookworm 上那个，版本 4.0.2）不接受它。`/usr/bin/kill -s SIGNAL -- -PGID` 以退出码 1 打印用法错误，进程组原地不动；去掉 `--` 也不行，`-s SIGNAL -PGID` 同样被拒，`-SIGNAL -PGID` 退出码 0 却根本没投出信号。只有 shell 自己的 `kill` 内建接受 `kill -s SIGNAL -- -PGID`，所以投递改经 `/bin/sh -c`，并且解释器用绝对路径指名——解析操作数列表的那个内建由宿主选定，而不是由镜像恰好装了哪个 shell 决定。
- **等沙箱内部给出命令边界信号（shell 集成）。** 是延期，不是否决：它需要在容器里有一个参与者（`PS0`/prompt 钩子或一层包装）并改动镜像，而且它会替换掉落地规则而不是扩展它。当前规则是一个有界的启发式，它的两种等待原因对调用方都可见。

## 后果

- **要终端就得给 `pods/exec`。** 一次性命令依旧从不使用 `kubectl exec`，只有 `openPty` 用。宿主的 Role 必须在沙箱命名空间里授予 `pods/exec`；不提供终端的部署就不该授予：失败范围仅限 `terminal_open`。
- **宿主进程从此需要一个真实终端库。** 需要 `node-pty`（工作区里已有依赖，来自 `subprocess-local`），并且宿主进程与沙箱镜像两侧都要有 `/dev/ptmx`。加载失败时 `container-transport` 会把原因一并报出来，而不是降级。
- **沙箱镜像的内容成了契约的一部分。** 会话身份直接从 `/proc` 读出（`/proc/self/stat` 与 `/proc/<pid>/stat`），不经 `ps`；信号经镜像里 `/bin/sh` 的 `kill` 内建投到进程组，解释器以绝对路径指名。镜像没有可读的 `/proc` 时一条终端也开不出来，失败发生在 `terminal_open`；`/bin/sh` 上没有一份 POSIX shell 时投不出信号，失败发生在投信号的那次操作。
- **落地规则证明不了「在等输入」。** 一条不出声的长时间命令与一个等待输入的子进程无法区分，两者都以 `stdin_read` 落地。调用方能看见等待原因的名字，可以继续发输入，而期限仍然给这次 send 定界。
- **终端 I/O 有三处上界**：会话保留的尾部（`maxOutputBytes`）、provider 的历史缓冲（`scrollbackMaxBytes`、`scrollbackLines`）、以及单次读取（`readMaxBytes`）。模型读一次长构建看到的是有界的尾部并带 `truncated`，而不是整条流；大量中间输出可能从历史里被丢掉。
- **窗口大小每条会话固定，没有 resize。** 全屏程序只在启动时读一次尺寸。加 `resize` 需要在 Definition 上新增一个操作，以及一条到运行时 CLI 的投递通道，而目前没有消费者需要它。
- **`terminal_open` 的 `type` 参数必须与注册的类型一致。** 默认值（`shell`）跟着 `tool-bash-persistent` 自己的默认值；改名的部署必须同时配这两个工具。把 `terminal-bash` 与本 provider 一起挂载会在加载时以 `DUPLICATE_BACKEND` 失败，这正是单一 provider 类型的预期行为。
- **空闲会话由 Agent 生命周期与沙箱空闲退出回收，不由 provider 计时。** Agent 还活着的终端就一直保留它的沙箱会话；provider 里没有空闲计时器，因为 `ctx.terminals` 没有给出「还在用」的判据。

## 验证

- `packages/tenant/container-transport/tests/session-probe.spec.ts` 钉住会话身份的两端：握手接受终端把换行翻译成的 CR LF（也接受管道会发的单个 LF）、忽略 shell 对握手行本身的回显，`parseState` 读出活着的进程组、把 `-1` 读成「没有前台进程组」、忽略不认识的行。它还逐字钉住 `signalArgv` 构造的 argv——绝对路径 `/bin/sh`，信号与进程组作为位置参数传入。procps 不接受「程序」那种写法是实机测量的事实，不是单元测试能证明的东西。
- `packages/tenant/container-transport/tests/pty-session.spec.ts` 用一个假终端与一个按脚本应答的沙箱驱动会话：交给运行时的 argv 与窗口大小、启动噪音的剔除、保留尾部的上界、拒绝一条从未报告会话的命令（并把它的输出尾部报出来）、等待上界、由 `/proc` 得出的 `pid`、按进程组投递信号、组长占着终端时拒绝 `SIGKILL`、`TERM`→`SIGKILL` 升级与「仍有进程组活着」的失败、失败关闭后的重试、以及启动前后两个取消窗口。
- `packages/tenant/container-transport/tests/transport.spec.ts` 钉住 CLI runner 的失败语义：子进程没读完喂进去的 1 MiB 就退出时，这次调用仍以它的退出码结算，并且不在宿主进程上留下 `uncaughtException`/`unhandledRejection`；拉不起来则以指名该二进制的错误拒绝。前一条不是空洞断言——摘掉那个 stdin 监听，它就会以 `Error: write EOF { code: 'EOF' }` 落到进程级监听上而失败。
- `packages/tenant/terminal-container/tests/backend.spec.ts` 只把 `ctx.containerRuntime` 换成假实现，用真实的 `ctx.terminals` 注册表驱动已注册的 backend：spawn 载荷（cwd 的引用、环境变量、`exec`）、启动横幅的采纳、四种落地结论、分页与截断、经 `SIGINT` 取消、经注册表关闭、以及运行时开不出会话时什么都不发布。
- `packages/tenant/container-k8s/tests/runtime.spec.ts` 与 `packages/tenant/container-docker/tests/docker.spec.ts` 各自钉住该 provider 那份贡献：寻址到正确沙箱的 `exec -i -t` argv、抵达宿主终端的窗口大小与宽限期、以及身份探测和其余命令走同一个 tool-exec 端点。
- 真正的集群仍然是这些事唯一能得到验证的地方：沙箱命名空间里的 `pods/exec`、保持 `Tty: true` 的 `kubectl exec -i -t`、宿主镜像里的 `node-pty` 与 `/dev/ptmx`、远端退出码的传递、`setsid` 下的会话组长/进程组行为，以及沙箱在会话中途被替换时客户端看到什么。
