# Agent Note：container-docker 以稳定名字预热租户容器

Status: implemented

[English](2026-08-26-container-docker-prewarm.md) | 中文

## 问题

`container-docker` 运行时会按租户、在第一次 `exec` 时以新生成的 `dsh-<partition>-<random>` 名字懒式启动 tool-exec 容器，由此带来两笔开销。租户首个请求一旦触达工具，就要先付整段容器冷启动——`docker run`、端口发布、容器内 Node 绑定端口的就绪等待（部署宿主机上约 0.5s）——之后才开始干活；而且 teardown（逐个容器 `docker rm -f`）只在优雅 dispose 时运行，被 kill 重启的宿主机既留着旧随机名容器继续跑，新进程又另外生成一个，孤儿容器于是跨重启不断累积、从不回收。

## 决策

启动时预热每个启用租户的容器，并给每个租户一个稳定、按租户分区的名字。`DockerContainerRuntime` 现在声明 `static inject = ['tenants']` 和一个 `[Service.init]` 生成器：遍历租户注册表，对每个启用租户 fire-and-forget 地调用 `ensure(tenant)` 而不去 await——因此启动不被 docker 延迟阻塞，且与预热赛跑的请求会经既有的 `starting` map 并入那次进行中的启动（每进程最多一次冷启动）。`startContainer` 去掉随机后缀：名字就是 `dsh-<partition>`，并在 `docker run` 之前先对同名容器执行 `docker rm -f`（容器不存在时是 no-op），于是非优雅关机最多留下一个容器，且会被下一次启动清掉。

## 考虑过的替代方案

- **维持懒启动与随机名**（现状）：否决——首次工具调用仍要付冷启动，崩溃仍会每次重启留下一个孤儿容器。
- **启动时 prune 所有 `dsh-*` 容器**：否决——无法用新鲜度区分本进程与并发启动的服务端的容器，prune 会驱逐活跃的租户执行世界。
- **对稳定名「收养或创建」**（检查正在运行的 `dsh-<partition>`、复用其端口、仅在不存在时才启动）：推迟——它能在进程重叠时同时消除冷启动与驱逐，但需要检查挂载与健康状态，单宿主部署眼下用不到。

## 后果

- 租户从第一次调用起就在温热容器上运行工具；冷启动被移出请求路径、并入进程启动，预热期间的请求共享同一次启动。
- 稳定名把每个租户钉在每个 Docker 宿主上至多一个容器，重启不再累积孤儿；同名容器会在下一次启动前被清掉。
- 稳定名也意味着同一宿主上相继重叠启动的两个 `dsh` 进程会互相重建（驱逐）对方的同名容器——此处在无状态下退化为一次重新预热，但要在流量中途交接的共享宿主多副本部署应改用「收养或创建」（已记入包 README 的 Known Limitations）。

### 验证

- `packages/tenant/container-docker/tests/docker.spec.ts` 现在断言：预热循环对每个启用租户各起一个 `dsh-tenant_<id>_<hash>` 容器（跳过禁用租户）并先清同名；空闲回收测试统计三次 `rm -f`（启动前清除、空闲回收、重启前清除）。8 个测试全绿。
- 在部署宿主机（`192.168.138.130`）实测：冷启动约 524ms（`docker run` 约 351ms、端口约 46ms、就绪约 127ms），温热 exec 约 16ms；预热把冷路径从每个租户请求里消除了。