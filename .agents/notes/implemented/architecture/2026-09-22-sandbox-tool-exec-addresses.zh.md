# Agent Note: tool-exec 沙箱发布与拨号的宿主地址可配置

Status: implemented

[English](2026-09-22-sandbox-tool-exec-addresses.md) | 中文

## 问题

每个 (租户, 用户) 作用域都在自己的 `dsh-tool-exec` 容器里跑工具调用，由 harness 经 Docker socket 启动。provider 用 `-p 127.0.0.1::<port>` 发布该容器的 HTTP 端口，并按 `http://127.0.0.1:<port>` 拨号，两者都是 provider 里的字面量。这一对地址只在 harness 与宿主共用网络命名空间时成立，多租户部署之所以跑 `network_mode: host` 正是这个原因。harness 跑在网桥网络上自己的容器里的部署则完全用不了它：在那个容器内 `127.0.0.1` 就是 harness 自己，因此任何沙箱都不可达，而发布的端口落在只有宿主看得见的地方。要改这一点是改源码，不是改部署。

## 决策

`Config` 新增两个字符串字段，默认都是 `127.0.0.1`：

- `publishHost`——`docker run -p` 把 tool-exec 端口绑定到的宿主地址。
- `connectHost`——provider 为该发布端口拨号的宿主地址。

`startContainer` 发布 `${publishHost}::${toolExecPort}`，而 `exec` 与就绪轮询共用同一个由 `connectHost` 构造的 `toolExecBaseUrl(port)`。

网桥模式的部署把 `publishHost` 设为网桥网关地址、把 `connectHost` 设为网关名（`host.docker.internal`，provider 已经用 `--add-host` 把它加进沙箱）。两个默认值都让 host 网络部署行为不变。

## 考虑过的替代方案

- **两个地址共用一个字段**：否决。在容器场景里两者不同——端口发布在网关地址上，却要用网关名拨号。
- **运行时探测模式**：否决。provider 里没有任何东西能判断它自己的进程是否与宿主共用网络命名空间，猜错会静默发布到错误地址。
- **默认发布在 `0.0.0.0` 上**：否决。`/exec` 服务不做任何鉴权，发布到所有网卡等于把无鉴权的命令执行暴露给周边网络；该字段让部署可以放宽到网关地址，而不是放宽到全部。
- **把沙箱放进共享 Docker 网络并按 DNS 寻址**：作为更大的改动否决——它会替换掉就绪轮询与 `docker port` 所读的发布端口约定。

## 后果

- 把 harness 跑在容器里的部署经 Docker 网关访问它的沙箱，并在自己的 profile 里改 `publishHost` / `connectHost`，而不是改 provider 源码。
- `publishHost` 扩大了无鉴权命令接口的可达范围：网关地址把该接口留在宿主的 Docker 网络上，`0.0.0.0` 则不然。
- 交叉链接：容器模型与生命周期来自 [container-docker 预热](2026-08-26-container-docker-prewarm.md) 与 [沙箱资源上限](2026-09-22-sandbox-resource-ceilings.md)。
