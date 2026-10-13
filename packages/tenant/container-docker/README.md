# @deepseek-ai/dsh-container-docker

[`dsh-container`](../container) 接缝的本地 Docker/Podman provider。它按 (租户, 用户) 拉起一个 *tool-exec* 服务容器，通过 HTTP 往该容器在宿主机回环上发布的端口发请求来运行命令（ip+host），并挂载三层数据：案件的共享目录挂到 `/shared`、该用户在该案件的工作目录以读写挂到 `/workspace`、该用户跨案件的全局目录挂到 `/global`（配置了 `usersRoot` 时），工具以只读挂到 `/tools`。`/shared` 与 `/global` 默认只读（`sharedReadOnly`、`usersReadOnly`）：这两棵树由业务侧写入，沙箱只是读取方，可写就意味着一个用户的沙箱能改到同案件其他用户的输入，也会让它们下面那两层只读的技能挂载失去意义。技能另外按层挂进一个聚合根：案件的、跨案件的、系统的三层各自只读挂到 `/opt/data/skills/<层>`，案件脚本遍历那个根去发现技能。容器在该用户第一次工具调用时懒式拉起——按用户的容器在启动时没有用户可供预热——名字稳定且按 (租户, 用户) 分区。不同租户、同一租户的不同用户始终落在不同容器，进程与文件系统从不共享内核上下文；容器自身文件系统在回收时丢弃——租户或用户的持久状态只有它的挂载。

## 配置

```yaml
- name: '@deepseek-ai/dsh-container-docker'
  config:
    runtime: 'docker'               # or 'podman'
    network: 'bridge'               # used unless the tenant sets network: 'none'
    toolExecImage: 'dsh-tool-exec:latest'  # in-container /exec server image
    # PATH that image gives its commands; set it together with toolExecImage (default: the Debian base image's)
    # toolExecImagePath: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    toolExecPort: 8642              # container port that server binds
    publishHost: '127.0.0.1'        # host address that port is published on
    connectHost: '127.0.0.1'        # host address the harness dials for it
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip /global
    systemRoot: '/root/.dsh/system' # host system skill tree; mounted read-only at the same path
    pythonRoot: '/opt/.dsh/pyenv'   # host Python runtime (no Python in the image); mounted read-only at the same path
    # idleTimeoutMs: 300000         # 可选：容器在最后一次 exec 之后空闲这么久就自行退出
    # maxOutputBytes: 67108864      # 可选：覆盖每条输出流的容器内上界（默认 67108864 字节，见「容器模型」）
    # memoryLimit: '2g'             # optional: hard memory ceiling; swap is capped at the same value
    # cpuLimit: 2                   # optional: CPU ceiling in whole cores
    # cliTimeoutMs: 60000           # optional: bound on one docker/podman invocation
    # startTimeoutMs: 180000        # optional: bound on one whole cold start
    # transportTimeoutMs: 600000    # optional: bound on one tool-exec round trip
    # readyTimeoutMs: 10000         # optional: bound on the wait for /exec to answer
    # readyPollMs: 30               # optional: interval between readiness probes
```

## 容器模型

当用户在某个 (租户, 用户) 作用域内第一次工具调用时，provider 为该作用域启动一个 tool-exec 容器。它先清除同名容器（`docker rm -f`，不存在时是 no-op——非优雅关机因此不会遗留孤儿容器），再以稳定、按 (租户, 用户) 分区的名字 detached 拉起 tool-exec 镜像：

```
docker rm -f dsh-<tenantPartition>-<userPartition>
docker run -d --name dsh-<tenantPartition>-<userPartition> \
  --network <network|none> -p <publishHost>::<toolExecPort> \
  [--memory <memoryLimit> --memory-swap <memoryLimit>] [--cpus <cpuLimit>] \
  -v <workspaceRoot>/users/<sub>:/workspace \
  -v <workspaceRoot>/shared:/shared \
  [-v <usersRoot>/<sub>:/global] [-v <toolsRoot>:/tools:ro] \
  -v <workspaceRoot>/shared/skills:<workspaceRoot>/shared/skills:ro \
  -v <workspaceRoot>/shared/skills:/opt/data/skills/case:ro \
  [-v <usersRoot>/<sub>/skills:/opt/data/skills/user-global:ro] \
  [-v <systemRoot>/skills:/opt/data/skills/system:ro] \
  [-v <systemRoot>:<systemRoot>:ro] \
  [-v <pythonRoot>:<pythonRoot>:ro] \
  [-e PATH=<pythonRoot>/bin:<toolExecImagePath>] [-e VIRTUAL_ENV=<pythonRoot>] \
  [-e PYTHONPATH=<pythonRoot>/lib/python3.<minor>/site-packages] \
  -e DSH_CASE_ID=<tenant id> -e DSH_TENANT_ID=<tenant id> -e DSH_USER_ID=<subject> \
  <toolExecImage>
```

上面每一条绑定挂载源都会在触碰容器 CLI 之前先在本宿主上校验：源不是已存在的目录就启动失败，报错里同时给出该路径、它对应的容器内挂载点，以及它属于哪个 (租户, 成员)——这正是运维定位「该建谁的目录」所需的信息。这条校验的存在理由，是 Docker 会把不存在的绑定挂载源建成空目录：没有它，启动会成功、沙箱会显示健康，而该主体拿到的是一个空的 `/workspace`。按租户划分的源由 [`dsh-tenant-admin`](../tenant-admin/README.md) 预置——建租户与加成员时创建 `<workspaceRoot>/shared/<tier>` 与 `<workspaceRoot>/users/<sub>`；`usersRoot`、`systemRoot`、`pythonRoot` 以及租户的 `toolsRoot` 则由部署自己维护。聚合根下的三层技能目录就是这些根的子目录，同样得先存在：`<workspaceRoot>/shared/skills` 由 `dsh-tenant-admin` 建，`<usersRoot>/<sub>/skills` 与 `<systemRoot>/skills` 由部署在自己的根里建出来。

随后读取已发布宿主机端口（`docker port`），等待容器的 `/exec` 服务应答（设上限，从而没有 exec 会与容器内 Node 绑定端口的时序竞争），再把每次 exec POST 到 `http://<connectHost>:<port>/exec`——一次性命令从不执行 `docker exec`。同一作用域并发首次调用会并入那次进行中的启动，所以每个 (租户, 用户) 每进程最多付一次冷启动。运行镜像来自 `toolExecImage`；租户记录本身不携带镜像。设置 `idleTimeoutMs` 时，provider 把这个预算作为 `DSH_TOOL_EXEC_IDLE_MS` 注入容器，容器自己判定「没有在途请求、且距上一次请求已超过预算」后退出，下次 exec 再懒式重启。

交互式会话是唯一的例外，因为它需要 `/exec` 服务给不出的东西：一个真正的 TTY。`POST /exec` 收一条请求、答一个已完成的结果，因此经它开出的会话没有 stdin、没有窗口大小，也没有投递信号的通道。`openPty` 于是用本宿主分配的真实终端运行 `docker exec -i -t <container> -- <command>`，而它需要的每一条会话事实——这个终端跑的是哪个会话、哪个进程组占着终端——都用一次性命令经同一个 `http://<connectHost>:<port>/exec` 从沙箱内部读出（[`container-transport`](../container-transport)）。会话身份取自沙箱自己的进程表：镜像里没有 `procps`（没有 `ps`），所以 `/proc` 是唯一可用的进程表，provider 用一个 POSIX shell 循环读 `/proc/[0-9]*/stat` 得到会话号与前台进程组，并用作为程序运行的 `kill -s <信号> -- -<pgid>` 给进程组发信号。终止一条会话先 `SIGTERM`，一段宽限期后 `SIGKILL`，再复核进程组是否真的没了；`disposeGraceMs` 就是这个宽限期。窗口大小与宽限期都来自调用方（`ContainerPtyOptions.rows` / `cols` / `disposeGraceMs`）：大小属于模型开的那条会话，宽限期属于这条会话的收尾方式，两者都不是部署配置。

空闲为什么由容器判定而不由宿主计时：每个请求都要到达容器，而宿主只看得见自己缓存的那个句柄——多副本部署下它会删掉另一个副本正在使用的容器。在途计数也不可省：一条比预算更长的命令是「正在执行」，不是「没人派任务」，所以计时从命令结束才算起。

容器退出属于正常结束，留下的是一个已退出的同名容器；provider 启动时会按托管标签收一次尸（`ps -a --filter label=dsh.dev/managed --filter status=exited -q` 之后 `rm -f`），只收已退出的——运行中的可能是另一个副本的沙箱。同一个 `idleTimeoutMs` 在 `container-k8s` 里是把预算注入 Pod 环境，容器退出后 Pod 停在 `Succeeded`，由同样的启动收尸清掉。

每一条被捕获的输出流另有上界：provider 把 `maxOutputBytes`（默认 67108864，即每条流 64 MiB）作为 `DSH_TOOL_EXEC_MAX_OUTPUT_BYTES` 注入容器，容器超过上界后**继续读完**这条流——停止读会让子进程在写满管道时阻塞，而它并不会因此变小——但只保留末尾一段，并在结果里把该流标成已截断。上界必须在容器里生效，因为原始流是容器先攒满、宿主才轮得到加界的：`ctx.subprocess` 给结果加界时，一条 `find /` 的输出早已把沙箱的内存吃光，容器被杀、沙箱进终态，下一次调用只能重建它。它只需**高于**宿主自己的每条流预算（`dsh-bash-local` 的 `maxOutputBytes` 默认 64000），模型看到的截断提示因此仍由宿主给出；反过来它必须留在部署里那些更大的上界之上——整份文件读取，以及 `run_code` 自己 64 MiB 的载荷上界——否则那些本来整段读得回来的结果会被截断。保留末尾而不是开头与宿主自己的捕获一致，读到被截断的流的那一层各自决定怎么办：子进程适配器把它报成 lossy，文件系统适配器宁可报 `FS_TOO_LARGE`，也不把末尾一段当成整份文件。

`pythonRoot` 指向所有沙箱共用的那一份 Python 运行时——解释器、标准库与已安装的包都在同一个目录里——以同一绝对路径只读挂进沙箱。tool-exec 镜像自身不带解释器，所以这份挂载就是沙箱唯一的 Python：`<pythonRoot>/bin` 被前置到 `PATH`，`<pythonRoot>/pyvenv.cfg` 使该目录成为 `VIRTUAL_ENV`，`<pythonRoot>/lib/python3.<minor>/site-packages` 加入 `PYTHONPATH`。于是这一个目录同时定下解释器版本和全部依赖，这正是无公网部署要的：运维往它里面装包，下一个沙箱就有该依赖，既不用重建镜像、不用重新分发，也没有需要与镜像对齐的版本。省略该字段时不挂任何东西、也不设任何 Python 环境变量，结果是沙箱里根本没有 `python3`——这份挂载是硬依赖，不是可选优化。配了 `pythonRoot` 而本进程读不到它时，是加载直接失败而不是降级：宿主进程会自己先读这个目录再把路径交给容器运行时，因此只有 Docker daemon 能解析的路径——通常是因为该宿主目录没有按同路径挂进宿主进程自己所在的那个容器——否则就会挂进一个空目录、什么都不配。配置的目录里三个标记一个都没有时，同样会在加载阶段被拒绝，而 Docker 会把不存在的绑定挂载源建成空目录，正是这条规则的来由：那个空目录就是「挂载了、但环境从没建出来」的样子，不拦就会什么都不配。所以这里不依赖运维记住顺序——环境没建出来会挡住宿主启动，而不是让沙箱在没有解释器的情况下跑起来；两条出路是把这个路径上的环境装出来，或者去掉 `pythonRoot`。三个标记里只要有任意一个，该目录就合法，并且只按有的那个配置。

虚拟环境不是自包含的，所以这里要放的不是它：`python3 -m venv --copies` 只复制解释器可执行文件，而该文件仍然要从它被创建时的那个系统加载标准库（`/usr/lib/python3.<minor>/`）与 `libpython3.<minor>.so`。镜像里已经没有任何 Python，也就没有那个系统可依赖，所以挂载目录必须是一份可重定位的完整构建——`python-build-standalone` 的 `x86_64-unknown-linux-gnu` `install_only` 树，或一个完整的 conda 环境。

在有网的机器上准备好它，然后整目录拷进内网（内网主机取不到包）。解包一份可重定位构建（`x86_64-unknown-linux-gnu` 的任意 3.x `install_only` 构建解出来都是 `./python`），用它自己的 `pip` 把案件工具装进去——这一步放在容器里跑，因为 tool-exec 镜像自己没有任何 Python 来执行那个 pip——最后把整个目录拷到内网主机上沙箱要挂的那个路径：

```sh
curl -LO https://github.com/astral-sh/python-build-standalone/releases/download/<release>/cpython-3.11.<patch>+<release>-x86_64-unknown-linux-gnu-install_only.tar.gz
tar -xzf cpython-3.11.*-x86_64-unknown-linux-gnu-install_only.tar.gz
mv python pyenv
docker run --rm -v "$PWD/pyenv:/pyenv" -e PATH=/pyenv/bin:/usr/bin:/bin \
  --entrypoint sh dsh-tool-exec:latest -c 'python3 -m pip install openpyxl xlrd pandas'
rsync -a pyenv/ <internal-host>:/opt/.dsh/pyenv/
```

挂上去之后，一条命令就能证明沙箱看得见它：

```sh
docker run --rm -v /opt/.dsh/pyenv:/opt/.dsh/pyenv:ro \
  -e PATH=/opt/.dsh/pyenv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --entrypoint sh dsh-tool-exec:latest -c 'python3 -c "import openpyxl, pandas, platform; print(platform.python_version())"'
```

唯一的版本约束落在构建上，而不是落在扩展上：挂载的 Python 必须能在镜像的 glibc 上跑——镜像是 Debian 12（glibc 2.36），为更新的 glibc 构建的版本在容器里会以 `GLIBC_2.<minor> not found` 起不来——这就是为什么支持用 `x86_64-unknown-linux-gnu` 的 python-build-standalone 构建（它们按更老的 glibc 编译）。扩展的 ABI 则相反，它自动跟随解释器本身：用挂载的 `pip` 装出来的包就是按那个解释器打标签的（`*.cpython-3XX-*.so`），不会再出现解释器在镜像里时那种「包与解释器对不上」的情况。

skill 要通过 `PATH` 调 `python3`（或 `pip`），不要写 `/usr/bin/python3`：镜像在那个路径上没有解释器，而 provider 会把挂载的 `bin` 目录放在最前。镜像仍然应答的一个历史路径是 `/opt/hermes/.venv/bin/python3`——那是给按该布局写死的 skill 用的包装脚本，它 exec `PATH` 里的 `python3`；没有挂载环境时它会以 `python3: not found` 失败，而不是跑去执行别的解释器。

`docker run -e PATH=…` 是替换镜像的值而不是追加，因此把 `<pythonRoot>/bin` 放到最前就必须重述镜像其余部分的 `PATH`：这就是 `toolExecImagePath`，默认取 Debian 基础镜像的值（`node:22-bookworm-slim`；仓库里的 `docker/Dockerfile` 自己没设 PATH）。当 `toolExecImage` 换成 PATH 不同的镜像时要一并设置，否则那个镜像追加的目录在沙箱里不再解析。

每个容器还携带自己的身份：`DSH_CASE_ID` 与 `DSH_TENANT_ID` 是租户 id，`DSH_USER_ID` 是该用户，因此要定位自己所在案件的 skill 直接读它们，而不必从容器名或 `/shared` 目录名反推——Docker 把 `/etc/hostname` 设为容器 id，那种反推没有可用的输入。

这条路径的每一步都有上界，因为一旦发出就无法取消：`cliTimeoutMs` 限定单次容器 CLI 调用（宿主机上还没有该镜像时，`run -d` 里包含一次拉取），`startTimeoutMs` 限定一整次冷启动，`transportTimeoutMs` 限定一次 tool-exec 往返——它要覆盖命令在容器内的执行时间，长时间的构建就花在这里。超过上界的启动会被丢弃**并清掉缓存条目**：下一次调用于是重新启动一个容器，而不是并入那次永远不结束的启动——若把该条目留在缓存里，这个 (租户, 用户) 在该宿主进程的余生里将无法执行任何工具调用。自带上界的调用方（shell 期限、工具超时策略）会把上界传进来，因此已过期或被中止的调用不必等待进行中的启动；启动本身仍会继续服务于共用同一 key 的其他调用方。超过上界的 tool-exec 往返不会被重试——上面的替换规则假定“拒绝”意味着命令从未执行，而超时给不出这个保证。启动在 `docker run -d` 之后失败时，同名容器会留到下一次启动的清除为止。

`publishHost` 与 `connectHost` 默认是宿主机回环，前提是宿主进程与宿主机共用网络命名空间。宿主自身跑在容器里时，要通过 Docker 网关访问已发布端口：把 `connectHost` 设为 `host.docker.internal`，并把 `publishHost` 放宽到网桥网关地址（例如 `172.17.0.1`）。优先用网关地址而不是 `0.0.0.0`——`/exec` 服务不做任何鉴权，发布到所有网卡等于把无鉴权的命令执行暴露给周边网络。

tool-exec 镜像把零依赖的 `/exec` 服务（`src/tool-exec.ts`）打包到 Debian-slim + Node 上，从而保住文件系统适配器 `stat`/`find`/`base64`/`test`/`command -v` 的 coreutils 语义。在仓库根目录构建：

```sh
docker build -f packages/tenant/container-docker/docker/Dockerfile \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t dsh-tool-exec:latest .
```

覆盖基座时要保持 slim。`docker/build-images.sh` 会同时构建本镜像与宿主，本镜像的基座取自 `TOOL_EXEC_NODE_IMAGE`（默认 `node:22-bookworm-slim`），与宿主的 `NODE_IMAGE` 分开：完整的 `node:22-bookworm` 是 buildpack-deps，自带 `python3-minimal`，用它构建的沙箱会在挂载的解释器之外多带一个，并在 `PATH` 上遮蔽它。任何一次构建都用 `docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3 || echo NO-PYTHON'` 自检，必须打印 `NO-PYTHON`。

镜像还带一个 ripgrep 二进制，装在 `/usr/local/bin/rg`：`glob`/`grep` 的执行侧就是这个容器，而宿主解析的是它自己 `node_modules` 里的 `@vscode/ripgrep`，那个绝对路径在容器里不存在，所以租户栈用 `tool-fs-search` 的 `ripgrepPath` 指向容器里的这个路径（`packages/tenant/tenant-app/src/spine.ts`）。二进制来自 npm 平台包 `@vscode/ripgrep-linux-x64` 的 `bin/rg`，因此构建不访问 GitHub，只走 `docker build` 已经传入的 `NPM_REGISTRY`；构建期以 `test -x /usr/local/bin/rg && /usr/local/bin/rg --version` 自检，失败即构建失败，不会让一个没有 `rg` 的镜像发出去。镜像构建完可以同样方式验证：`docker run --rm --entrypoint sh dsh-tool-exec:latest -c '/usr/local/bin/rg --version'`。

## Model Experience

### Tenant- and user-scoped container execution

#### What the model sees

无。`ctx.containerRuntime` 服务于模型下方的文件系统与子进程适配器：不含工具、提示词或会话事件。

#### Token effect

每次请求零直接 token。

#### KV Cache effect

与活跃请求无关：该包从不触及请求前缀。

## Known Limitations and Deferred Work

- **每个 Docker 宿主每 (租户, 用户) 一个容器。** 稳定名字把每个主体钉在单个具名容器上，因此同一宿主上两个相继启动的 `dsh` 进程会互相驱逐或重建同名容器（第二个 `rm -f` 停掉第一个的，再起自己的）；容器无状态，所以这只退化为一次重新预热，但要在流量中途交接的共享宿主多副本部署应改用「收养或创建」而非「清除再启动」。
- **`internal` 网络由部署方负责。** 租户要在无公网的情况下出网，依赖部署方创建的内网；该 provider 只是跳过 `none` 并用自己的配置名。
- **无镜像拉取策略。** 容器启动后会等待其 `/exec` 服务就绪，但拉取本身由部署方负责；部署方应预先拉取 tool-exec 镜像，或用 `run` 时即可解析的镜像。
- **无磁盘上限。** 只限制内存与 CPU。主体的写入落在宿主拥有的 `/workspace`、`/shared`、`/global` 绑定挂载目录里，因此存储配额需要该 provider 不施加的文件系统或卷级机制。
- **输出上界管的是捕获，不是命令自己的内存。** `maxOutputBytes` 逐条流生效，因此一条同时写两条流的命令最多占住两倍的上界；而一条自己吃掉整个容器内存的命令（例如在内存里排序一个大文件）仍然能撑死沙箱——这一层只保证沙箱不会因为**捕获**而无界增长，容器内存的那个上界要用 `memoryLimit`。
- **挂载的 Python 运行时是沙箱唯一的解释器，且只在宿主侧探测一次。** `pythonRoot` 的布局（`bin`、`pyvenv.cfg`、`lib/python3.<minor>/site-packages`）在 provider 构造时读取，因此继续往该目录里装包对下一个沙箱立刻生效，而在宿主进程启动之后才创建这些路径需要重启。镜像不带 Python，所以没挂载就启动的沙箱里没有 `python3`，需要比镜像的 Debian 12 更新的 glibc 的构建在容器里起不来。配置的 `pythonRoot` 读不到、或三个标记一个都没有时，是加载失败，而不是什么都不挂。该目录还必须能被宿主进程按同一路径读到，而不只是 Docker daemon 能解析：配置的 `pythonRoot` 不是本进程可读的目录时 provider 会拒绝加载，而宿主自身跑在容器里的部署必须把该宿主目录按同一路径挂进那个容器。
- **从未再被使用的沙箱要等运维收尾。** 容器自己的空闲退出与启动收尸覆盖了「容器已经退出」这一类；一个仍在运行、但其 (租户, 用户) 之后再没被用到的容器会留到运维按标签删除为止——删掉运行中的容器，等于让一个副本毁掉另一个副本正在用的沙箱。
- **交互式会话随沙箱一起消失。** 容器被 `rm -f`、被重建（同名清除再启动，或宿主进程重启后的清理）或按空闲预算退出，都会带走里面的每一条终端会话：下一次写会失败、会话的 `done` 落地，终端报给它的是一个已退出的会话而不是活着的。会话不可能跨容器保留，因为终端活在当初被附加到那个容器的 CLI 进程里。
- **无终端尺寸变更。** `openPty` 在会话打开时就把窗口大小定下来，因此只为 40×160 开的终端，会按这个尺寸渲染任何启动时读一次大小的程序。改变已有终端的尺寸需要在 `container` 上加一个操作、并给运行时 CLI 一条投递通道，而这两者目前都没有调用方。
- **宿主侧需要 node-pty 与 `/dev/ptmx`。** 真实终端由本宿主分配（`docker exec -i -t` 在管道 stdin 上会被 Docker CLI 自己的 CheckTty 拒绝），所以宿主进程需要能加载 `node-pty` 且容器里有 `/dev/ptmx`；缺失时 `openPty` 会在启动阶段报出具体原因，一次性命令路径不受影响。
- **会话探测用的是一次性命令。** 会话的 `foreground()` / 信号投递都经 `/exec` 打给同一个沙箱；沙箱的 `/exec` 服务中途不再应答时，得到的是探测失败而不是一个错误的前台进程组，这条会话随后按自己的期限落地。
