# @deepseek-ai/dsh-container

[English](README.md) | 中文

容器运行时 Service Definition（`ctx.containerRuntime`）：一个租户作用域容器执行世界的共享所有权。文件系统与子进程适配器等候同一运行时，因此文件与进程操作都住在每个对外租户的同一个隔离 Linux 世界里。已交付的 provider 是 [`@deepseek-ai/dsh-container-docker`](../container-docker)。

## 形态

- `ContainerCommandResult` — 一个已完成命令的 `exitCode` 加上捕获的 `stdout`/`stderr`。
- `ContainerExecOptions` — 可选的 stdin 输入与取消。
- `ContainerRuntime`（`ctx.containerRuntime`）— 抽象的 Service Definition，只有一个原语：`exec(command, args?, opts?)`，它在环境租户的容器内运行（每次调用从 `requireTenant()` 解析）。

## 模型体验

### 容器命令执行

#### 模型看到什么

无。`ctx.containerRuntime` 运行时服务模型之下的文件系统与子进程 provider：没有工具、提示词或会话事件。

#### Token 影响

每个请求零直接 token。

#### KV Cache 影响

与在线请求无关：本包从不触碰请求前缀。

## 已知限制与延期工作

- **没有显式生命周期原语。**`exec` 惰性物化租户的容器；销毁属于每个 provider 的 dispose effect（停止它启动的每个容器）。