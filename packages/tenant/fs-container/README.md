# @deepseek-ai/dsh-fs-container

[`dsh-fs`](../../fs/fs) capability seam 的容器 provider。路径、内容、列出、写入与编辑都在环境租户的容器内操作 — 与子进程 provider 服务的是同一执行世界 — 因此文件操作绝不脱离租户的隔离边界。

相对路径落在**调用方会话自己的目录** `/sessions/<会话 id>`，与那个会话的 shell 命令跑在同一层：调用方给的 `cwd` 是它自己那台机器上的路径，容器里不存在，这与 `ContainerRuntime.exec` 对带会话的命令所做的覆盖是同一条规则。没有会话在作用域里时（宿主自己的工具、技能发现、自己指定了 cwd 的调用方），配置的 `root` 生效。

## 配置

```yaml
- name: '@deepseek-ai/dsh-fs-container'
  config:
    root: '/workspace'   # container path relative requests resolve against when no session is in scope
```

provider 注入 `containerRuntime`（例如 [`dsh-container-docker`](../container-docker)）；`/workspace` 必须是该 provider 发布的租户工作空间挂载。镜像必须携带 GNU coreutils（`stat`、`cat`、`find`、`base64`）。

## Model Experience

### Filesystem access inside the tenant container

#### What the model sees

无。`ctx.fs` provider 服务模型之下的文件工具与 shell 消费者：没有工具、提示词或会话事件。

#### Token effect

每个请求零直接 token。

#### KV Cache effect

与在线请求无关：本包从不触碰请求前缀。

## Known Limitations and Deferred Work

- **路径身份是词法的，而非 realpath。**`resolve` 规范化但不解析符号链接，因此别名不共享身份；`lstat` 仍会报告链接类型。
- **版本 token 是 stat 身份**（`kind|size|mtime`）。在同一 mtime 秒内的重写可能不会推进版本。
- **`streamText` 是单块**：整个文件经 `cat` 捕获而非流式；非常大的文件不流式。
- **二进制检测基于 NUL**，`readBytes` 走 `base64` 往返；接近全量但有大小上限的读取，而非流式原始路径。
- **CRLF 文件在编辑时被 LF 规范化**，之后不还原。
- **写入是重命名原子的但不验证持久性**：`cat > tmp && mv` 在容器文件系统内是原子的；无 `fsync` 等待。
