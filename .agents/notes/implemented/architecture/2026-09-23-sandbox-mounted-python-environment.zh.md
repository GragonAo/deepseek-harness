# Agent Note：沙箱挂载宿主维护的 Python 环境

Status: implemented

[English](2026-09-23-sandbox-mounted-python-environment.md) | 中文

## 问题

多租户部署跑在无公网的内网里，因此案件 skill 需要的 Python 依赖既不能在容器启动时安装，放进 tool-exec 镜像也意味着每改一次依赖就要重建镜像、并把它重新分发到每台宿主。运维要的正好相反：宿主上维护一份 Python 环境、挂给执行层，改这一个目录就等于更新所有沙箱。

把解释器留在镜像里等于同一个运行时有两个源头。镜像里的 Python 定死了挂载进来的每个包必须匹配的 ABI，所以换一个更新的 Python 就意味着重建镜像并重新分发；而镜像构建时装的那批依赖是一份快照，案件要再加一个就得再打一个镜像。运维要的是「一个目录就是全部答案」——版本和包都在里面——而这只有镜像自己不带解释器才成立。

把在别处建好的虚拟环境挂进来在沙箱里用不了。有一份 vendored 环境的 `bin/python3` 指向 `/root/miniconda3/envs/py313`，沙箱里根本没有这个解释器，而它的编译扩展也是按那个解释器打标签的。

要定位自己所在案件的 skill 此前只能从容器名和 `/shared` 目录名反推身份，而 Docker 把 `/etc/hostname` 设为容器 id，这种反推没有可用的输入。平台知道租户和用户是谁，沙箱不知道。

## 决策

`container-docker` 的 `Config` 新增 `pythonRoot`——以同一绝对路径只读挂进沙箱的宿主目录（`-v <pythonRoot>:<pythonRoot>:ro`）；同时每个容器还会拿到自己的身份环境变量。

provider 在构造时于宿主侧读取一次 `pythonRoot` 的布局：容器的启动参数在其生命周期内固定，所以探测不该塞进沙箱自己的 shell 逻辑。读取通过注入的 `HostPathProbe`（`src/python-env.ts`）进行，因此测试解析布局时不必碰宿主文件系统。三个互相独立的探测决定三个变量：

- `<pythonRoot>/bin` 存在 → `-e PATH=<pythonRoot>/bin:<toolExecImagePath>`。`docker run -e PATH=` 是替换而不是追加镜像的值，所以前置的同时要把镜像自己的 PATH 一并写回，该值由 `Config.toolExecImagePath` 承载（默认取镜像的 Debian 基础 PATH，`node:22-bookworm-slim`）。
- `<pythonRoot>/pyvenv.cfg` 存在（说明是虚拟环境）→ `-e VIRTUAL_ENV=<pythonRoot>`。
- `<pythonRoot>/lib/python3.<minor>/site-packages` 存在 → `-e PYTHONPATH=` 这些目录以 `:` 连接，同时也照顾部署自己往镜像里装的解释器；挂载进来的解释器不靠它也能找到自己的 site-packages。

省略该字段时不挂任何东西、不设任何 Python 变量，也完全不调用探测，因此不维护该目录的部署行为与从前完全一致。配了 `pythonRoot` 而本进程读不到它时是加载直接失败：宿主进程会自己先读这个目录再把路径交给容器运行时，因此只有 Docker daemon 能解析的路径——通常是因为该宿主目录没有按同路径挂进宿主进程自己所在的那个容器——否则就会挂进一个空目录、什么都不配。本进程读得到、但三个标记一个都没有的目录同样直接失败，理由相同；而 Docker 会把不存在的绑定挂载源建成空目录，所以「环境从没建出来」在现实里正是以这个状态出现的。三个标记里只要有任意一个，该目录就合法，并且只按有的那个配置。

tool-exec 镜像不带 Python，所以挂载目录就是沙箱唯一的解释器，必须是一份可重定位的完整构建。虚拟环境不是：`python3 -m venv --copies` 只复制解释器可执行文件，而该文件仍然要从它被创建时的那个系统加载标准库与 `libpython`，而沙箱里已经没有任何这样的系统。受支持的来源是 `python-build-standalone` 的 `x86_64-unknown-linux-gnu` `install_only` 树（或一个完整的 conda 环境）：在有网的机器上解包，在容器里用它自己的 `pip` 装好案件工具（tool-exec 镜像自己没有任何 Python 来执行那个 pip），再把整个目录拷到内网主机上沙箱要挂的那个路径。

```sh
tar -xzf cpython-3.11.*-x86_64-unknown-linux-gnu-install_only.tar.gz && mv python pyenv
docker run --rm -v "$PWD/pyenv:/pyenv" -e PATH=/pyenv/bin:/usr/bin:/bin \
  --entrypoint sh dsh-tool-exec:latest -c 'python3 -m pip install openpyxl xlrd pandas'
rsync -a pyenv/ <internal-host>:/opt/.dsh/pyenv/
```

唯一的版本约束落在构建上、不落在扩展上：挂载的 Python 必须能在镜像的 glibc 上跑——镜像是 Debian 12（glibc 2.36），为更新的 glibc 构建的版本在容器里起不来——这就是为什么支持用 `x86_64-unknown-linux-gnu` 的 python-build-standalone 构建。扩展的 ABI 则相反，它跟随解释器，而不必再去匹配另一个解释器：用挂载的 `pip` 装出来的包就是按那个解释器打标签的（`*.cpython-3XX-*.so`）。skill 要通过 `PATH` 调 `python3`（或 `pip`），不要写 `/usr/bin/python3`；镜像仍然应答的唯一历史路径是 `/opt/hermes/.venv/bin/python3`——那是给按该布局写死的 skill 用的包装脚本，它 exec `PATH` 里的 `python3`。

身份走同一批启动参数：`DSH_CASE_ID` 与 `DSH_TENANT_ID` 是租户 id，`DSH_USER_ID` 是用户（`UserId`，即通过认证的主体字符串本身）。容器进程环境会到达 tool-exec 服务拉起的每条命令，因此 skill 直接读自己的案件，而不必反推。

多租户组合包在 `container-runtime` 行上设置 `pythonRoot: /opt/.dsh/pyenv`，而 `docker/docker-compose.multi-tenant.yml` 把该宿主目录按同一路径挂进宿主容器：探测跑在宿主进程里，正是这次挂载让这一行的配置得以生效。

## 考虑过的替代方案

- **镜像里留一个解释器、只挂载包**：否决。镜像里的 Python 仍然会定死挂载包必须匹配的 ABI，换 Python 版本仍然是重建镜像，挂载也就不是「全部答案」而是要去适配镜像。这还会留下一个镜像并不需要的构建步骤（pip 引导脚本和它的索引地址），以及一个需要与挂载目录对齐的解释器版本。
- **把案件依赖烤进 tool-exec 镜像**：否决。以后再补一个案件 skill 需要的依赖，就得在构建时有可达的镜像源，并把重建后的镜像分发到每台宿主——这正是本次改动要消除的约束。
- **在容器内前置 `PATH`**（入口点或 shell 包装）：否决。那样探测就跑在沙箱里，而在沙箱里「目录不存在」与「挂载配错了」无法区分，环境也会依赖沙箱自身的逻辑，而不是固定的启动参数。
- **把环境挂到固定的容器内路径**再把变量指过去：否决。虚拟环境会把自己的绝对路径写进 `pyvenv.cfg`、shebang 和 `.pth` 文件，所以沙箱必须在该环境被建出来的那个路径上看到它——与系统 skill 树遵循的是同一条规则（[沙箱只读挂载系统 skill 树](2026-09-22-sandbox-system-skill-mount.md)）。
- **镜像里带一个解释器，作为没挂载时的兜底**：否决。兜底就是第二个源头：skill 解析到它就会跑一个挂载包并非为它构建的版本，而失败会以导入错误的形式出现，而不是「挂载缺失」。
- **把身份放进每次 tool-exec 请求的 `env`** 而不是容器的环境：否决。`docker run -e` 能到达沙箱里的每个进程，包括 skill 自己拉起的进程；而按请求传 `env` 只能到达 provider 发出的那条 argv。
- **为挂载的环境单独开一个能力包**：否决。在拥有容器启动参数的 provider 上，这只是一个配置字段加一次挂载；单独成包就要为一个部署侧诉求配上 Service Definition 和消费方。

## 后果

- 无公网部署往唯一一份宿主目录里装包，下一次沙箱启动就能用上，既不用重建镜像也不用重启宿主。但在宿主进程启动之后才在该目录里创建 `bin`、`pyvenv.cfg` 或 `lib`，需要重启——布局只在构造时探测一次。
- 这份挂载是硬依赖，不是优化：没挂载就启动的沙箱里根本没有 `python3`（`command -v python3` 为空，`/opt/hermes/.venv/bin/python3` 以 `python3: not found` 失败，退出码 127）。因此从不配置 `pythonRoot` 的部署，从此没有那个由镜像提供的解释器；而镜像过去装好的案件工具（包括 xlsx 读取器）也必须成为挂载目录的一部分。
- 镜像构建不再需要访问任何包索引：只为 esbuild 需要 npm 源，因此在没有 PyPI 镜像的内网主机上也能构建，镜像里也不再有任何钉死的解释器版本。
- 大声失败把这条顺序要求接管了下来，而不是留给运维：宿主目录必须先存在、而且里面真的装着环境，再配 `pythonRoot`，否则宿主拒绝启动。Docker 会把不存在的绑定挂载源建成空目录，而这个空目录同样会被拒绝，所以漏建环境的部署会停在加载阶段，而不是让沙箱在没有解释器的情况下跑起来——挡住它的是这次拒绝，不是运维的记忆。
- `pythonRoot` 必须能被宿主进程按同一路径读到，而不只是 Docker daemon 能解析。宿主自身跑在容器里的部署要把该宿主目录挂进那个容器；少了这次挂载，加载会带着路径直接失败，而不是挂进一个空目录、不设任何 Python 变量。
- 一份环境服务所有租户：装进它的包对每个租户的沙箱都可用，且只读。要做到按租户隔离 Python，需要按租户各给一份根目录。
- `toolExecImagePath` 之所以要把镜像自己的 PATH 写回，是因为 `docker run -e PATH=` 会替换它。它默认取镜像的 Debian 基础 PATH；部署若自带 `toolExecImage` 且其 PATH 里还有别的目录，就要把这个字段设成一致的值，否则在配置了 `pythonRoot` 时那些目录不再解析。
- 部署补丁层只要命中 `container-runtime` 这一行，就是整行替换它的 `config` 对象，因此必须把 `usersRoot`、`pythonRoot` 与各上界和自己要加的字段一并重述。省略的字段会退回 schema 默认值，而这两个根的默认值是「没有值」。
- `DSH_TENANT_ID` 与 `DSH_CASE_ID` 是同一个 id：在本产品里案件就是租户。

### 验证

- `packages/tenant/container-docker/tests/docker.spec.ts` 覆盖：挂载的环境以同路径只读挂载出现，并前置 `PATH`、设置 `VIRTUAL_ENV` 与 `PYTHONPATH`；只有 `bin` 的目录只前置 `PATH`；没有 `pythonRoot` 时不挂任何东西、不设任何 Python 变量、也从不探测；配了 `pythonRoot` 但路径不存在或是文件时加载失败且错误信息里带该路径；目录存在而三个标记一个都没有时同样加载失败且错误信息里带该路径；配置的 `toolExecImagePath` 出现在写回的 `PATH` 里；三个身份变量携带当前租户与用户 id。该文件的 `hostPathProbe` 套件用临时目录覆盖生产环境的宿主读取。该文件 26 个测试全绿。
- `packages/tenant/tenant-demo/tests/multi-tenant-loader.spec.ts` 把组合出的 `container-runtime` 行钉到一个临时目录，因此这次真实组合启动不依赖运行它的机器上是否有 `/opt/.dsh/pyenv`。
- `npx tsc -p packages/tenant/container-docker/tsconfig.json --noEmit` 干净。
- `docker build -f packages/tenant/container-docker/docker/Dockerfile -t dsh-tool-exec:latest .` 成功，且 `docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3; command -v pip3'` 什么都不输出：镜像里没有解释器。
- 挂载已对构建出的镜像实测：把 `python-build-standalone` 的 `cpython-3.11.16` `x86_64-unknown-linux-gnu` `install_only` 树按同一路径只读挂到 `/opt/.dsh/pyenv`，把它的 `bin` 前置进 `PATH`，并由它在无 Python 的镜像里跑自己的 `pip` 装好案件工具——`python3 -V` 报 3.11.16，`sys.executable` 与 `sys.prefix` 都落在挂载内，`/opt/hermes/.venv/bin/python3` 可执行，`import openpyxl, pandas` 成功（3.1.5、3.0.6）。不挂载时同一个镜像报 `python3: not found`，该包装脚本以 127 退出。
