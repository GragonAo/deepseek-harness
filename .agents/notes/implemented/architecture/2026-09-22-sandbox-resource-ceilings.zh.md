# Agent Note: tool-exec 沙箱带有内存与 CPU 上限

Status: implemented

[English](2026-09-22-sandbox-resource-ceilings.md) | 中文

## 问题

每个 (租户, 用户) 作用域都在自己的 `dsh-tool-exec` 容器里跑工具调用。provider 没有向 `docker run` 传任何资源参数，Docker 自身也不施加上限，因此一个主体的编译、测试或数据作业可以把它同租户伙伴与宿主自身服务的 CPU、内存一并吃掉。多租户部署宿主（4 核、16 GB，与案件平台的容器共用）没有任何办法约束这一影响范围，而 `container-docker` 也没有暴露可供运维设置的 Config 字段。

容器模型决定了修法：容器按 (租户, 用户) 懒式启动、空闲时约占 14 MB，因此大多数只是停着、只有少数会同时执行。于是上限能在不向停着的容器收费的前提下保护宿主——前提是它只是上限。

## 决策

`Config` 新增两个可选字段，都直接传给 `docker run`：

- `memoryLimit`（Docker 容量语法，如 `2g`）→ `--memory <limit> --memory-swap <limit>`
- `cpuLimit`（整数核数）→ `--cpus <n>`

两者都是上限，不是预留。`--memory` 是 cgroup 上限：空闲容器仍然只占它自己的进程（实测 14 MB，同一测试里的上限是 256 MB），而 `--cpus` 是 CFS 带宽，因此空闲主体不会占着核不让忙碌主体用（实测：被限容器 0% 时未限的兄弟容器用满 284%）。只有越界主体自己被停掉——超出内存上限会在它自己的容器内 OOM kill 进程（实测部署宿主上退出码 137、`OOMKilled=true`），同租户伙伴与宿主不受影响。

`--memory-swap` 被钉在内存上限上，而不是留在 Docker 默认的两倍上限，这样越界主体就地死掉，而不是把宿主拖进 swap、拖慢其他每一个租户。

省略字段时不传任何参数，因此单租户与开发部署行为不变。

## 考虑过的替代方案

- **为每个容器预留内存或 CPU**（cgroup `cpu.shares` 权重，或 Kubernetes 式的 request/limit 拆分）：否决。负载是尖峰式的、大部分时间空闲，预留会让停着的容器白白占着宿主，还需要一个本 provider 没有的调度器。
- **只限内存**：否决。CPU 密集的主体不触发任何内存上限就能饿死同租户伙伴。
- **插件内置一个默认上限**：否决，违反「插件中不得硬编码可调项」规则——宿主能匀出多少随部署而变，所以它是部署设置的、经校验的 Config 字段。
- **磁盘上限**：未实现。主体的写入落在 provider 不拥有的、绑定挂载的宿主目录里，因此存储配额需要文件系统或卷级机制；已记入包 README 的 Known Limitations。

## 后果

- 运维可以从 `cordis.yml` 约束单个主体的影响范围；多租户部署在 `idleTimeoutMs`（它限定有多少容器保持停着）之外同时设置 `memoryLimit: '2g'` 与 `cpuLimit: 2`。这两个字段同样到达 Kubernetes 后端，只是内存值写成 quantity（`8Gi`）、落在 Pod 容器的 `limits` 上（见[沙箱资源上限](2026-10-14-sandbox-resource-limits.md)）；本条里的 `cordis.yml` 示例是 docker 语法。
- 作业正当需要超过上限的主体，现在会在自己的容器内以 OOM kill 失败（退出码 137），而不是慢慢跑完；上限按容器计，更重的工作负载意味着改部署配置。
- 本次变更不带磁盘上限，因此主体仍能通过它的挂载写满宿主的磁盘。
- 交叉链接：容器模型与生命周期来自 [多租户第二阶段](../../proposed/architecture/2026-08-24-multi-tenant-phase-2.md) 与 [container-docker 预热](2026-08-26-container-docker-prewarm.md)。
