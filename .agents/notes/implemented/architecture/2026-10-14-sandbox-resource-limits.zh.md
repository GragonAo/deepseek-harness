# Agent Note: 给沙箱容器的内存与 CPU 加上界

Status: implemented

[English](2026-10-14-sandbox-resource-limits.md) | 中文

> 一次报告会话的 `python3` 拖垮了它所在节点上的全部负载，原因是 Kubernetes provider 根本没有声明任何资源上界：`container-docker` 有 `memoryLimit` / `cpuLimit`，Kubernetes provider 两个都没有，而租户配置还把这几个名字列在 `backend: k8s` 的拒绝名单里。

## 问题

一次报告生成会话跑在 Kubernetes 沙箱里，它的 `python3` 长到 6.3 GB RSS（虚拟地址空间约 6.85 GB）。那个 Pod 既没有 `requests` 也没有 `limits`，因此是 `besteffort`：没有任何东西给这个进程封顶，内核在这台 15 Gi 的宿主上宣布了一次**节点级** OOM 并杀掉了它。同一次事件也杀掉了那个节点上属于其他负载的进程，因为 OOM killer 按 `oom_score_adj` 挑受害者，而 besteffort 的 Pod 得分就是可杀。沙箱容器随后以 137（`OOMKilled`）退出，而 `restartPolicy: Never` 意味着它不会被替换，任务于是死在半途：没有报告，也没有上传。

这两半都不是缺能力。`buildSandboxPod` 早就接受一个 `resources` 字段，`container-docker` 也早就用 `--memory` 与 `--cpus` 落实了 `memoryLimit` / `cpuLimit`。Kubernetes provider 从未填过那个字段，而 tenant-app 的配置校验把这两个名字列在 `backend: k8s` 的拒绝名单里——两个后端被文档写明的那份对称，正好断在保护节点的那一个字段上，而 container-k8s 的 README 把后果记成了待办。

## 决策

- `container-k8s` 增加 `memoryLimit`（Kubernetes quantity，例如 `8Gi`）与 `cpuLimit`（整数核数），都可省略，含义与 `container-docker` 的同名字段相同。tenant-app 的配置对 `backend: k8s` 接受并转发这两个字段。
- 它们只落成沙箱容器的 `limits`；provider 从不声明 `requests`。集群拿它做什么不由 provider 决定：在验收集群（k8s v1.28.15）上，一个只写 `limits.memory=1Gi` 的 Pod 落库后带回了等值的 `requests.memory`，这是用一个合成 Pod 在一个既没有 LimitRange、也没有变更型 webhook、`managedFields` 为空的命名空间里复现的。因此那里的 `memoryLimit` 同时是预留量，而预留量决定能否调度：该节点的 allocatable CPU 是 4 核，所以吃满核数的 `cpuLimit` 会让沙箱 Pod 永远停在 `Pending` 并报 `Insufficient cpu`，于是这份部署只配 `memoryLimit: 6Gi`、不配 `cpuLimit`。在确实把 Pod 留成只有 limits 的命名空间里，它保持 `Burstable`、照常突发；无论哪种情况，越界都是被杀在自己的 cgroup 里。
- `assertQuantity` 在加载期校验这个值。apiserver 同样会拒绝写错的 quantity，但只在创建 Pod 时，而且报的是装配好的 spec，不是配置里的那个字段。
- 这个值是 Kubernetes quantity，所以同一个含义在两个后端里的字面写法不同：docker 写 `2g`，Kubernetes 写 `8Gi`。对一边合法的值会被另一边响亮地拒绝，而不是被悄悄取整。

## 考虑过的其他方案

- **同时声明 `requests`**：否决——它把每个沙箱的内存在节点上永久钉住，而沙箱是断续使用、按需突发的。
- **把 Kubernetes 的 resources 对象整体作为配置暴露**：否决——那会让整套资源模型成为这份部署的配置面，而需要上界的量只有内存与 CPU。
- **把 docker 风格的 `2g` 归一化成 quantity**：否决——那是在替运维猜他输入的值；响亮地拒绝并把字段名报出来更好。

## 后果

- 不配 `memoryLimit` 的部署仍然是不限的沙箱。container-k8s 的 README 把这件事写成了生产要求，而不是留成待办，因为失败形态是节点级 OOM，而不是一个变慢的沙箱。
- 声明 limits 会改变 Pod spec，因此指纹变化：改动之前创建的沙箱会被判为 `runs a different spec`，直到它被替换。请在安静的窗口部署，或删掉那个终态沙箱。
- CPU 按 `String(cores)` 渲染，所以 docker 风格的 `2` 与 quantity 的 `2` 是同两核。
- 这条上界由内核执行，不只是被记录：配 `memoryLimit: 6Gi` 时，验收集群的沙箱容器读到 `/sys/fs/cgroup/memory.max` 为 `6442450944`，因此失控的命令被杀在它自己的 cgroup 里，而不是拉着节点一起倒。
- 这两个值由宿主在启动时从租户配置读取，改它们就要重启宿主。验收部署以 `Recreate` 策略滚动：旧 Pod 先被删掉，接替的 ReplicaSet 可能要一分钟以上才出现，租户面因此短暂不可用，这类改动适合放在安静的窗口。
- 交叉链接：本决策的 docker 那一半是 [tool-exec 沙箱的内存与 CPU 上限](2026-09-22-sandbox-resource-ceilings.md)，而那条防止 `find /` 意外顶到上界的捕获上界是[沙箱给每条被捕获的输出流加上界](2026-10-08-sandbox-output-bound.md)。

### 验证

- `packages/tenant/container-k8s/tests/pod-spec.spec.ts` 钉住装配与加载期校验：带上这两个字段建出的 Pod 有 `limits.memory` / `limits.cpu` 且没有 `requests`，不带的 Pod 完全没有 `resources`；`assertQuantity` 接受 `8Gi`、`500m`、`2`，并命名为字段地拒绝 docker 写法的 `2g`。
- `packages/tenant/container-k8s/tests/runtime.spec.ts` 读 provider 真正交给集群的那一份 spec：两个字段都配上时，建出的 Pod 带 `limits.memory: 8Gi` 与 `limits.cpu: '2'`；不配时一个都不带。
- `packages/tenant/tenant-app/tests/app.spec.ts` 断言配置对 `backend: k8s` 接受并转发这两个字段：`memoryLimit: 8Gi` / `cpuLimit: 2` 解析成 `{backend: 'k8s', memoryLimit: '8Gi', cpuLimit: 2}`。
- 13 个测试文件、211 条用例通过；`pnpm run typecheck` 干净，lint 在改动的文件里没有新增告警。
- 在验收集群上这条上界落到了内核：配 `memoryLimit: 6Gi` 时沙箱 Pod 带 `{"limits":{"memory":"6Gi"},"requests":{"memory":"6Gi"}}`，容器读到 `/sys/fs/cgroup/memory.max` 为 `6442450944`。此前那个沙箱死于节点级 OOM（退出 137、`OOMKilled`、`restartPolicy: Never`）的会话，重新下发后跑在这个有上界的 Pod 里。