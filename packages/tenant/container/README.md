# @deepseek-ai/dsh-container

容器运行时 Service Definition（`ctx.containerRuntime`）：一个租户作用域容器执行世界的共享所有权。文件系统与子进程适配器等候同一运行时，因此文件与进程操作都住在每个对外租户的同一个隔离 Linux 世界里。已交付的 provider 是 [`@deepseek-ai/dsh-container-docker`](../container-docker)。

## 形态

- `ContainerCommandResult` — 一个已完成命令的 `exitCode` 加上捕获的 `stdout`/`stderr`。
- `ContainerExecOptions` — 可选的 stdin 输入与取消。
- `ContainerRuntime`（`ctx.containerRuntime`）— 抽象的 Service Definition，两个原语：`exec(command, args?, opts?)` 在环境租户的容器内运行一条一次性命令（每次调用从 `requireTenant()` 解析），`openPty(options)` 在同一个沙箱里开一条交互式会话。
- `ContainerPtyOptions` / `ContainerPtySession` / `ContainerPtyRead` / `ContainerPtyOutcome` / `ContainerPtyForeground` / `ContainerPtySignal` — 交互式会话的请求与句柄：`rows`/`cols` 是窗口大小，`maxOutputBytes` 是保留输出的上界，`disposeGraceMs` 是收尾时 `SIGTERM` 到 `SIGKILL` 之间的宽限期，`signal` 只用于取消尚未发布的启动；会话给的是 `pid`（会话组长的进程组）、`done`、`read()`、`write(data)`、`foreground()`、`signal(signal)`、`close(reason)`。

`openPty` 不带 `cwd` 与 `env`：这两样是运行时 CLI 自己的旗标（`docker exec -w/-e`、`kubectl exec` 没有对应旗标），放进定义就等于让一个 provider 的旗标成为所有 provider 的义务。调用方要一个工作目录或一组环境变量时，用 `sh -c` 自己包住命令——这正是 [`dsh-terminal-container`](../terminal-container) 的做法。

## Model Experience

### Container command execution

#### What the model sees

无。`ctx.containerRuntime` 运行时服务模型之下的文件系统与子进程 provider：没有工具、提示词或会话事件。终端这一面由 [`dsh-terminal-container`](../terminal-container) 接到 `ctx.terminals` 之后才成为模型可见能力，其模型体验记录在那个包里。

#### Token effect

每个请求零直接 token。

#### KV Cache effect

与在线请求无关：本包从不触碰请求前缀。

## Known Limitations and Deferred Work

- **没有显式生命周期原语。**`exec` 惰性物化租户的容器；销毁属于每个 provider 的 dispose effect（停止它启动的每个容器）。
- **交互式会话随沙箱一起结束。**`openPty` 返回的会话活在 provider 的沙箱里，沙箱被替换、被驱逐或按空闲退出后，该会话只能报出「已结束」，无法恢复：终端活在当初附加到那个沙箱的 CLI 进程里。
- **没有 resize。**窗口大小是打开会话时定下的，之后无法改变；加一个 resize 操作需要一条投递到运行时 CLI 的通道，而目前没有调用方需要它。
