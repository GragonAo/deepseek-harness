# @deepseek-ai/dsh-container-transport

容器运行时 provider 用到的外部接缝：把「起一个子进程调 CLI」、「对 tool-exec 端口做一次 HTTP 往返」与「在宿主上分配一个真实终端并运行交互式 CLI」从 provider 里分离出来，provider 因此只负责挂载、命名、路由与生命周期，这些接缝可以用假实现直接做单元测试。

## 导出

- `cliRunner` / `ContainerCliRunner`：以子进程执行一次容器 CLI，返回退出码与输出；`timeoutMs` 到点即终止。
- `execToolCommand` / `ToolExecClient` / `ToolExecRequest` / `ToolExecResult`：向沙箱内 tool-exec 服务发起一次命令执行，返回退出码、标准输出与标准错误。
- `ptyRunner` / `ContainerPtyRunner` / `ContainerPtyTransport` / `ContainerPtyStart`：在宿主上分配一个终端并运行交互式 CLI，返回一条双工会话（写 stdin、读输出、终止）。`docker exec -i -t` 在管道 stdin 上会被 Docker CLI 自己的 CheckTty 拒绝，所以这条接缝必须给出真实终端；`node-pty` 不可用时它在启动阶段报出具体原因，而不是退化成没有 TTY 的伪会话。
- `openContainerPty` / `ContainerSessionExec` / `ContainerPtyOpen`：一个 provider 只提供 argv（`exec -i -t …`）与一个绑定到它已解析沙箱的一次性 exec，会话语义因此只实现一次：写握手、从沙箱自己的 `/proc` 读出会话号与前台进程组、保留有界输出、结束时先 `SIGTERM` 再 `SIGKILL` 并复核进程是否真的没了。两次信号都按进程组投递，走的是 `/bin/sh` 的 `kill` 内建而不是 PATH 上的 `kill` 程序（原因见下）。
- `session-probe` 的纯函数（`handshakeLine` / `parseHandshake` / `stateScript` / `parseState` / `signalArgv`）：会话身份与前台进程组的读写两侧，可脱离容器单独测试。

## Model Experience

None, as the transport seams run a container CLI and one tool-exec HTTP round trip; the runtime provider that calls them owns any model-visible result.

#### KV Cache effect

不影响。这里没有任何进入 prompt 或工具目录的内容。

## Known Limitations and Deferred Work

- 只覆盖 docker 与 k8s 两个后端共用的三种传输形态（CLI 子进程、tool-exec HTTP、宿主终端上的交互式 CLI）。新增后端若需要第四种传输方式，应当在这里加一条接缝，而不是把它内联进 provider。
- 会话身份只读沙箱自己的 `/proc`，不经 `ps`；信号按进程组投递，用的是 `/bin/sh` 的 `kill` 内建，而不是 PATH 上的 `kill` 程序——procps-ng 的 `kill` 不接受 `-s SIGNAL -- -PGID`（以用法错误退出、进程组原地不动），去掉 `--` 也不行（`-s SIGNAL -PGID` 同样被拒，`-SIGNAL -PGID` 退出码 0 却没有投出信号），所以投递必须由 shell 内建完成，解释器因此钉成绝对路径 `/bin/sh`。镜像只需要一份可读的 `/proc` 与一个 `/bin/sh`：缺 `/proc` 时开不出交互式会话，报错发生在打开会话时；`/bin/sh` 缺失或不是 POSIX shell 时投不出信号，报错发生在使用它的那一步。
- 没有 resize：终端大小在分配终端时定下，改变它需要在宿主终端与运行时 CLI 之间再开一条通道。
