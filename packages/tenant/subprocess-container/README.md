# @deepseek-ai/dsh-subprocess-container

[`dsh-subprocess`](../../subprocess/subprocess) capability seam 的容器 provider。`resolveExecutable` 与 `spawn` 对着环境租户的容器运行 — 与文件系统 provider 服务的是同一执行世界 — 因此工具进程绝不离开租户的隔离边界。

## 配置

无。它注入 `containerRuntime` 并把每个可执行文件与进程委托给共享 owner（例如 [`dsh-container-docker`](../container-docker)），其挂载的 `/workspace` 与 `/tools` 成为进程世界。

## Model Experience

### Subprocess execution in the tenant container

#### What the model sees

无。provider 服务模型之下的 `ctx.subprocess` shell 与工具消费者：没有工具、提示词或会话事件。

#### Token effect

每个请求零直接 token。

#### KV Cache effect

与在线请求无关：本包从不触碰请求前缀。

## Known Limitations and Deferred Work

- **捕获式执行，非流式。**`spawn` 把每个命令运行到完成，之后才结算 `done` 与 collect 读取器；本切片不支持管道（`'pipe'`）stdio 与运行中实时读取。因为不存在要发信号的活树，`terminate()` 是 no-op。
- **`pid` 为 `-1`。**捕获式执行不暴露容器内进程 id。
- **`resolveExecutable` 忽略 `env` 查找参数** — 查找使用容器的环境 `PATH`。
- **没有终端原语。**`spawnTerminal` 拒绝；PTY/终端消费者不在纵向切片范围内。
