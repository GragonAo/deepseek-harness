# Agent Note: 沙箱给每条被捕获的输出流加上界

Status: implemented

[English](2026-10-08-sandbox-output-bound.md) | 中文

> [沙箱自己决定自己的死期](2026-10-08-container-owned-sandbox-lifetime.md)里那套「由容器执行的预算」多了第二个成员：与空闲预算一样，输出上界由 provider 注入、由容器内的 tool-exec 服务执行，因为原始流是容器先攒满、宿主才轮得到加界的。

## 问题

tool-exec 服务用管道 stdio 拉起命令，把每一块到达的输出 push 进一个 `Buffer[]`，等子进程关闭时再 concat：那个数组没有任何上界。服务自己的模块注释把上界交给 `ctx.subprocess`（「规模与超时由 subprocess 能力负责」），而这句话只对返回给模型的结果成立——`packages/tenant/subprocess-container` 给它交出去的东西加上界时，容器早已把每一个字节都收下了。命令与那条上界之间就是一个只受容器内存约束的缓冲，所以一条命令的输出规模实际决定了沙箱能不能活下来。

多租户部署上就是这么发生的：两条 `find /` 各让一个沙箱 Pod 消失。`kubectl get events` 显示 01:55:27 与 02:03:30 各有一条 `Killing … Stopping container tool-exec`，约 15 秒后同名 Pod 被重建，而模型看到的是 `Error: container-k8s: sandbox … entered phase=Missing ready=false, a phase it cannot leave without being replaced`。沙箱随 Pod 一起死掉，代价是该主体下一次调用白付一次冷启动，而模型看到的是沙箱故障，不是一条本来跑得通的命令的输出。`container-docker` 有同样的暴露——容器里没有任何地方给捕获加上界，示例部署也没有设 `memoryLimit`——只是影响面更小：容器被杀之后毫秒级就能重建，Pod 不能。

## 决策

`ToolExecServerOptions` 增加 `maxOutputBytes`，即**每条被捕获的流**的字节上界，`runCommand` 用一个 `BoundedCapture` 执行它：超过上界后**继续消费**这条流，只保留最后 `maxOutputBytes` 字节。继续消费不是可选项——停止读会让子进程在写满管道时阻塞，命令永远不结束，沙箱就一直挂着那个在途请求。保留末尾与宿主已有做法一致（`ctx.subprocess` 的每条流预算同样留末尾），所以两层都截断的结果与只有一层截断时携带的是同样的字节。截断会被报出来：`ToolExecResult`（以及 `container-transport` 里的镜像类型）上的 `stdoutTruncated` / `stderrTruncated` 只在该流真的丢了字节时出现，调用方因此不必猜手里的文本是不是全部输出。

上界是部署配置，不是服务里的常量：`docker/entry.mjs` 按与空闲预算同一套校验读 `DSH_TOOL_EXEC_MAX_OUTPUT_BYTES`，两个 provider 各有一个 `Config.maxOutputBytes` 字段注入这个变量——docker 走 `docker run -e`，k8s 走 Pod 环境。它的具名默认值 `DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024` 把上界留在部署读得回来的东西之上：宿主自己的每条流预算是 64 KB（`dsh-bash-local` 的 `maxOutputBytes`，64000），`dsh-code-runtime-container` 的载荷预算是 64 MiB。因此被沙箱截掉的流，本来就是宿主也会截的那一类；反过来调大那个载荷预算就必须同步调大这里，这一点写在常量的 JSDoc 里。字段校验为正整数，变量缺失表示不加上界——服务自己不设任何默认，与空闲预算同一条规则，而两个 provider 总会注入一个值。

每个消费方拿到的是这个标记，而不是一种新的失败方式。k8s provider 把它带出传输层；`subprocess-container` 的 `CapturedReader.settle(full, containerTruncated)` 把这次读取标成 `lossy`，于是 `bash` 与 `pwsh` 渲染它们原有的截断提示，而不是把末尾一段当成完整结果；`fs-container` 的 `readText` / `readBytes` / `listDir` 直接抛 `FS_TOO_LARGE`——一份被静默截断的文件读会让 `editText` 拿着错的 `before` 去改文件，一份被截断的清单会把部分目录报成全部。

### 服务同样扛得住「命令根本没读的 stdin」

同一个服务还有第二条丢掉整条 exec 通道的路径，而且它与上界无关：`runCommand` 把请求里的 `stdin` 写进一条命令可能在自己读完之前就关掉的管道——把一大段脚本交给一个只读到第一行就退出的解释器就是这样。这次写入于是以 `EPIPE` 失败（Windows 上经 libuv 是 `EOF`，两端都消失之后是 `ECONNRESET`），而 `child.stdin` 上没有监听时它是未处理流错误，会把 tool-exec 进程一起带走。那正是这条上界要防的结果，只是从输入侧而不是输出侧到达。它记在这里而不是另开一份，是因为这份记录拥有 `runCommand` 与 `ToolExecServerOptions`：那个函数的失败方式记在一份记录里，不记成两份。

`runCommand` 把这三个错误码当作正常完成——子进程已经退出，它的退出码与已捕获输出就是答案，所以「stdin 没能全部送出去」不变成一次失败调用。监听只挂在 `child.stdin` 这一条流上，不是包住整个流程：其它写入错误会带着命令名拒绝，因为那是本进程写自己的管道失败，而不是命令拒绝输入。其余拒绝路径不变，拉起失败仍然优先：命令从未启动就没有退出码可报，所以带 `stdin` 的请求在拉起失败时照样答 `500`（`ENOENT`）。

## 考虑过的其他方案

- **超过上界就杀掉命令**：否决——它给一条正在工作的命令凭空造出一个失败，而模型还得不到任何解释；`find /` 这种量级的输出恰恰是「截断有用、杀掉没用」的场景。这条上界的用处是让沙箱活下来，不是管教命令。
- **只在宿主上加界**（即改动前的状态）：否决——宿主的上界作用在容器已经攒下的字节上，它拦不住那次攒的过程。给流的消费方加上界，跟持有这条流的代价是两件事。
- **改用 `memoryLimit`（以及将来的 Pod `resources`）**：作为本问题的答案否决——内存上限把失控的捕获变成一次 OOM 杀进程，正是这里要修的沙箱死亡；而一个主体合法的大作业不该决定这件事什么时候发生。[tool-exec 沙箱的内存与 CPU 上限](2026-09-22-sandbox-resource-ceilings.md)仍是「一个沙箱最多能从宿主拿走多少」的上界，本上界只是让捕获别意外顶到它。
- **到上界就停止读取这条流**：否决——子进程会在写满管道时阻塞、永不退出，一条大输出命令于是变成一次挂住的请求。无论服务怎么处理这些字节，它都得继续消费。
- **保留开头而不是末尾**：否决——那与宿主自己的捕获不一致，同一条命令会因为「哪一层的上界更小」而显示不同的字节：容器更小时给开头，宿主更小时给末尾。
- **截断但不报出来**：否决——这两个标记正是两层可以安全并存的前提。分不清末尾与完整值的调用方会改坏文件，也会错报结果的完整性。
- **stdout 与 stderr 共用一个上界**：否决——宿主自己的预算就是逐条流算的，共用一个上界让两层无法比较，还会让啰嗦的 stderr 挤掉调用方本来整段读回的 stdout。

## 后果

- 今天部署读到的内容不变：默认上界高于宿主的每条流预算、也高于现有每个单命令载荷预算，所以模型看到的流仍由宿主那一层按原样截断。超过 64 MiB 的流会在容器里被截断、被报成已截断，并且被读成失败而不是读成一个错的值：文件系统适配器直接拒绝，而这样被切掉的 `run_code` 载荷会在解析它自己的帧时失败，不会返回一个残缺的值。因此把 `dsh-code-runtime-container` 自己的载荷预算调到这条上界之上，是唯一需要两个值一起改的配置变更。
- 一条正在跑的命令最多占住 `maxOutputBytes` × 流的数量（同时写两条流时是字段值的两倍）的内存，这就是沙箱现在持有的量，而不再是整条流。
- k8s 沙箱多了一个环境变量，Pod spec 指纹因此变化：由更早的 provider 启动的 Pod 会被判为 `/runs a different spec/`，被第一次发现它的调用删掉并重建一次。docker 的启动参数同样变化，但没有对应代价，因为容器由缓存的启动过程重建。
- `packages/tenant/tenant-app/src/config.ts` 用 `rejectUnknown` 校验 `sandbox` 的键集合；租户应用部署按 provider 自己的字段名在那里设 `maxOutputBytes`，与该 provider 其余 `Config` 字段一样（见[租户栈的工具呈现与并发](2026-10-08-tenant-tool-presentation-and-concurrency.md)）。
- 这条上界保护的是捕获，不是命令自己的内存：自己吃掉容器内存的命令照样死，那个只能用 `memoryLimit`（docker）或 Pod `resources`（尚未实现）来管。
- 不经变量、直接 `docker run` 这个 tool-exec 镜像时，捕获仍然无界——与空闲预算一样是「省略即不限」；两个 provider 总会注入值，所以没有配置会意外走到这条路径上。
- 把一大段脚本交给「读都不读就退出」的命令不再打断这条通道：命令自己的退出码与输出照常答回，没送完的 stdin 只是没送完。

### 验证

- `packages/tenant/container-docker/tests/tool-exec.spec.ts` 在不依赖宿主 shell 的前提下钉住上界的行为——文件里每条命令（无论是否配上界）都走 `process.execPath -e`，所以没有 `sh` 的宿主上这套用例同样通过：低于上界与恰好等于上界的输出原样返回且不带截断标记；超出 1 字节时恰好保留最后 `maxOutputBytes` 字节；1000 字节上界下的一次 256 KiB 写入保留它的末尾；1 字节上界只保留最后一个字节；多字节流按 1000 **字节**（而不是字符）截断；stderr 与 stdout 各自独立受限；不配上界时 512 KiB 的流完整保留。
- 上界还与 `ToolExecRequest` 携带的其他字段组合着跑，而不是只单独跑：转发的 `cwd` 用相对路径读一份 4 KiB 文件、仍然只返回上界大小的末尾；一条把 stdin 全部读掉的命令把读到的字节数写进被保留的末尾；两者同时用、上界为 8 字节时返回的恰好是 stdin 那一半——丢掉 stdin 或忽略 `cwd` 的捕获会在这些用例上失败，而不是蒙过去。
- 同一个文件钉住 stdin 这一路：一条从不读 4 MiB stdin 就退出的命令仍然答 `200` 并带上它自己的退出码与输出，而且这个请求不留 `uncaughtException` 也不留 `unhandledRejection`——用例只在为自己的断言期间挂这两个监听、`finally` 里摘掉，所以它不会把未处理错误变成全局静默。带 `stdin` 载荷的拉起失败仍然答 `500` 并指名 `ENOENT`。非 `EPIPE` 写入错误的拒绝分支没有可达输入，因此没有用例覆盖它。
- 同一个文件用一条 16 MiB 的命令证明「继续消费」而不是只断言它：在 1024 字节上界下该命令仍然以 0 退出并返回上界大小的末尾——停止消费的读取方走不到这里（子进程会阻塞在写满的管道上，请求永不 settle）。
- `packages/tenant/container-docker/tests/docker.spec.ts` 与 `packages/tenant/container-k8s/tests/runtime.spec.ts` 分别断言配置值下的注入与省略配置时的默认值，因此两个 provider 都不会停止把预算交给沙箱。
- `pnpm exec tsc -b tsconfig.host.json` 无输出；`container`、`container-transport`、`container-docker`、`container-k8s`、`subprocess-container`、`fs-container`、`code-runtime-container` 的测试套件通过。
- 事故证据来自部署自己的事件输出（01:55:27 与 02:03:30 的 `Killing … Stopping container tool-exec`，约 15 秒后同名 Pod 被重建）；在那台集群上重跑一次 `find /` 是剩下的端到端检查，而它需要本改动所没有的集群访问权限。
