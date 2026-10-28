# Agent Note：记录沙箱的一生，并给库缓存一个可写的位置

Status: implemented

[English](2026-10-14-sandbox-diagnostics.md) | 中文

> 一个沙箱死于节点级 OOM，而宿主日志对此一言不发：provider 创建、收养、替换、收尸沙箱，一行都没留下，等到有人去看时，能解释这次死亡的集群已经不存在了。

## Problem

Kubernetes provider 掌管沙箱 Pod 的一生——它在第一条命令时创建一个、收养一个与当前规格相符的既有沙箱、替换一个已经进入终态的沙箱、删掉更早的宿主进程留下的终态 Pod——而这一切都是静默的。两个 provider 的源码里都没有任何一处调用 `ctx.logger`。促成这次改动的那次失败是一次 OOM 击杀：Pod 处于 `Failed`，会话的下一条命令悄悄拿到了一个新沙箱，而唯一能说明发生了什么的东西，在一个事件会过期的集群里。一句记下 Pod 名、阶段与它当时所受限额的宿主日志，本可以立刻结束那次排查。

同一个沙箱还暴露了第二个小一些的缺陷：每一条 import matplotlib 的命令都会打印 `mkdir -p failed for path /root/.config/matplotlib: [Errno 30] Read-only file system: '/root/.config'`。容器以只读根文件系统运行、`HOME` 是 `/root`，所以按默认位置写缓存的库写不进去、退回到临时目录，并把一段警告打进命令的输出。警告本身不是真正的代价——真正的代价是模型把它读成自己那条命令失败了。

## Decision

- provider 记录决定沙箱命运的四个事件：它创建的沙箱（连镜像与本次生效的资源上界，或 `no resource limits`）、它收养的沙箱（连读到的阶段）、它即将替换的沙箱（连阶段与该 Pod 的集群事件）、以及它在某个阶段收掉的终态 Pod。四处都是 `info`，只有替换那处是 `warn`。
- 一条日志的判定标准：它描述的是每个沙箱只发生一次、而不是每条命令都发生的事，并且系统里没有别的地方记录它。命令级日志被有意排除——沙箱已经把每条命令自己的输出与退出码交回来了。
- `MPLCONFIGDIR` 默认指向 `/tmp/matplotlib`，即 Pod 挂进来的那些可写位置之一；运维在 `env` 里给出同名项时以他的取值为准。只有当答案是某个挂载路径、而不是库自己的约定时，provider 才声明默认值。

## Alternatives considered

- **用 `debug` 记录，让生产宿主保持安静。** 否决：沙箱的死亡不是日常事件，而一个跑在 `info` 上的宿主恰好会丢掉这些为此而存在的日志。
- **记录 provider 在沙箱里跑的每一条命令。** 否决：沙箱已经交回命令自己的输出，那些行只会以工作负载的量级重复调用方手上的证据。
- **挂一个可写的 `/root/.config`，让库用自己的默认位置。** 否决：只读根是有意为之，而多一个可写挂载会让沙箱的可写面取决于镜像里恰好装了哪些库。
- **改成把 `HOME` 指向 `/tmp`。** 否决：`HOME` 同时锚定 `DSH_HOME`，改它挪动的是 harness 自己状态的落点，而不是某一个缓存的落点。
- **用同样的办法给每个库一个缓存变量。** 未采纳：`MPLCONFIGDIR` 回应的是每条 matplotlib import 都能复现的警告，镜像里没有观察到别的库以这种方式失败。

## Consequences

- 日志现在是唯一比集群事件活得久的沙箱记录，因此当会话的工作凭空消失时，它是运维先读的东西。
- 替换那行带着创建那行里的内存上界，足以在不回查集群的情况下区分 OOM 击杀与驱逐。
- `MPLCONFIGDIR` 只覆盖 matplotlib。另一个按默认位置写缓存的库仍会警告；每一个都是需要各自证据的单独决定。
- docker provider 仍然什么都不记录，因此两个后端在可观测性上不一致。这条差异记在它的 README 的 deferred work 里。

### Verification

- `packages/tenant/container-k8s/tests/runtime.spec.ts` 捕获 `ctx.logger` 并断言每一行的格式与参数：带 `limits {"memory":"6Gi"}` 的创建、无上界时创建报 `no resource limits`、带阶段的收养、带阶段与集群事件的替换（`; events: Warning OOMKilling: Memory cgroup out of memory`）以及没有事件的那种、还有从 `kubectl` 自己的输出里读出来的被收尸 Pod 名。
- 同一个文件钉住 `MPLCONFIGDIR`：未配置时 Pod 环境里是 `/tmp/matplotlib`；给 `env: {MPLCONFIGDIR: '/opt/cache'}` 时是运维的取值。
- container-k8s 包的 68 个测试通过，`pnpm run typecheck` 干净。
- 在验收集群上只读根是真实的：`touch /probe_ro` 以 `EROFS` 失败，`HOME` 是 `/root`，而在这之前每一次 matplotlib import 都打印出上面那段 `/root/.config` 警告。