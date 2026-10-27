# @deepseek-ai/dsh-subprocess-container

[`dsh-subprocess`](../../subprocess/subprocess) capability seam 的容器 provider。`resolveExecutable` 与 `spawn` 对着环境租户的容器运行 — 与文件系统 provider 服务的是同一执行世界 — 因此工具进程绝不离开租户的隔离边界。

## 配置

无。它注入 `containerRuntime` 并把每个可执行文件与进程委托给共享 owner（例如 [`dsh-container-docker`](../container-docker)），其挂载的 `/workspace` 与 `/tools` 成为进程世界。

## 产出文件

带会话身份的命令（`spec.env` 里含 [`dsh-tenant`](../tenant) 的 `DSH_SESSION_ID`）在 `done` 里报告本次运行创建或改写的文件：启动前在容器 `/tmp` 落一个标记文件，命令结算后列出会话目录下 mtime 晚于该标记的常规文件。两步都走容器自己的内核时钟，所以报告的是容器内绝对路径（`/sessions/<id>/…`，与 [`dsh-fs-container`](../fs-container) 的 `displayPath` 同一种写法），不需要主机侧路径映射；只被读取的文件保持原 mtime，因此永不出现在报告里。

观测是尽力而为的附加信息。标记落不下、扫描非零退出或被上限中止时 `produced` 缺席 —— 观测失败绝不让命令本身失败，调用方必须把缺席读作「没有可报告的写入」。两次观测 exec 各自以 5 秒为上限，与命令自身的超时无关。stdout 触到上限时丢掉首个残缺行，其余完整路径照常报告。

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
- **产出观测要两条额外 exec。**每条带会话身份的命令在真实命令之外多付一次 `touch` 与一次 `find`+清理；`find` 遍历整个会话目录，目录很大时它的成本随文件数增长（单次观测有 5 秒上限）。后台启动同样支付这次观测，但 `ShellProcess` 没有承载 `produced` 的通道，其结果被丢弃。
- **只覆盖会话目录。**命令写到会话目录之外的东西不在报告里；mtime 精度取决于容器里的存储（overlay/`emptyDir` 与 cephfs 这类共享卷的粒度不同），比标记更早的同一时间片写入可能漏报。
