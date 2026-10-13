# @deepseek-ai/dsh-terminal-container

容器沙箱里的持久终端：`ctx.terminals` 的一个 provider，把 [`dsh-container`](../container) 的交互式会话接成模型可用的终端 backend，因此 `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list`（[`tool-terminal`](../../terminal/tool-terminal)）与「一条 shell 跨多条命令复用」的 `bash`（[`tool-bash-persistent`](../../shell/tool-bash-persistent)）在多租户部署里跑在租户自己的沙箱里，而不是宿主进程上。

它注册的 backend 类型由 `backendType` 决定（默认 `shell`）。与 [`terminal-bash`](../../terminal/terminal-bash) 同时挂载会以 `DUPLICATE_BACKEND` 直接失败，这是刻意的：同一个类型只能有一个提供者，否则模型请求会落到哪个 shell 上取决于注册顺序。

## 会话模型

一条终端会话就是一条被附加到沙箱的交互式 CLI：`openPty` 在 (租户, 成员) 自己的沙箱里运行 `/bin/sh -c '<骨架>' <shellPath> <shellArgs…>`，其中骨架做两件事，然后 `exec` 成配置的 shell——进入 `cwd`（进不去就打印原因并以 126 退出），并把 `TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`、`DSH_SHELL=1`、`DSH_SESSION_ID=<会话所属 Agent>`、`DSH_PTY_SESSION_ID=<终端会话 id>` 传给它。`TERM=dumb` 与两个 pager 的存在理由和本地 shell 一样：模型读的是捕捉下来的文本，转义序列与分页器只会污染它。

输入与输出各有一条明确的规则：`send` 把文本（需要时补一个回车）原样写进终端，然后等一个可判定的落地条件；`read` 从有界的历史缓冲里按行分页取回（`offset` 是距最新一行的偏移，`count` 是行数，向上取整到行边界，并带 `truncated` 标记）。历史上界 `scrollbackMaxBytes` 与单次读取上界 `readMaxBytes` 都在 provider 这一层生效，因为模型真正看到的那份文本要在这里定界。

## 落地条件

终端层拿不到「这条命令执行完了」这个事实：沙箱里跑的是一条被附加的交互式 shell，宿主只看得到字节流。`send` 于是用三档可判定的条件落地，并把结论报给调用方：

- `stdin_read` — 终端安静了 `idleSilenceMs`，且一次 `foreground()` 探测显示仍有进程组占着终端：shell 或前台子进程在等输入，正是「命令跑完了，等你下一条」的样子。
- `inferred_idle` — 同样安静，但探测显示没有任何进程组占着终端：没有东西在读 stdin。
- `session_exit` / `timeout` — 会话结束（沙箱里的命令退出、容器没了），或到 `timeoutMs` 仍未满足前两档。

安静多久才算落地是 `idleSilenceMs`，两次轮询之间的间隔是 `pollIntervalMs`；每一次 send 至多触发一次 `foreground()` 探测，不会按轮询节奏反复打沙箱。已知的边界：一条长时间不出声的命令（`sleep 300`、一次没有输出的构建）与一个正在等输入的子进程在字节流上没有区别，所以它会以 `stdin_read` 落地，调用方再 `send` 时输入被写进同一个终端——`tool-bash-persistent` 就是这么继续的。

## 归属与生命周期

每条会话记在开它的那个 Agent 上（`terminal_*` 每次调用都会带上发起调用的 Agent，`ctx.terminals` 据此校验归属），关闭该 Agent 时它名下的容器会话随之关闭：先 `SIGTERM` 终端的前台进程组，`disposeGraceMs` 宽限期后 `SIGKILL`，再复核确实没进程了——终止失败会把真正的原因报出来，而不是让一条没有进程的会话留在沙箱里。会话随沙箱一起消失：沙箱被替换、被驱逐或按空闲退出后，会话的 `done` 落地，下一次 `send` 以 `session_exit` 落地而不是挂住。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `backendType` | `shell` | 注册到 `ctx.terminals` 的类型名；`terminal_open` 的 `type` 参数必须与它一致。 |
| `shellPath` | `/bin/bash` | 交互式 shell 的可执行文件。 |
| `shellArgs` | `['--noprofile', '--norc', '-i']` | 传给它的参数。 |
| `cwd` | `/workspace` | 会话的起始目录；spawn 请求带 `cwd` 时以请求为准。 |
| `rows` / `cols` | `40` / `160` | 分配终端时的窗口大小。 |
| `scrollbackLines` / `scrollbackMaxBytes` | `10000` / `4194304` | 每条会话保留的输出历史（行数上界与字节上界）。 |
| `readMaxBytes` | `262144` | 单次 `read` 返回的文本上界，必须不大于 `scrollbackMaxBytes`。 |
| `pollIntervalMs` | `50` | 观察输出的轮询间隔。 |
| `idleSilenceMs` | `3000` | 判定「终端安静下来」所需的静默时长，必须不大于 `timeoutMs`。 |
| `timeoutMs` | `30000` | 一次 send 的期限。 |
| `disposeGraceMs` | `3000` | `SIGTERM` 到 `SIGKILL` 之间的宽限期。 |

配置在加载时整体校验：空的 `backendType`/`shellPath`/`cwd`、非正整数的数值字段、`readMaxBytes > scrollbackMaxBytes`、`timeoutMs < idleSilenceMs` 都在这里失败，而不是等到第一次 `terminal_open`。

## Model Experience

### Durable terminals inside the tenant container

#### What the model sees

`terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list` 六个工具的文本结果，加上 `bash` 的每条命令结果：终端的输出、`read` 的行号范围、以及 `[wait: …]` / `[session: …]` 这样的落地原因行。文本完全来自沙箱里那条 shell 的输出，provider 只做有界保留与分页。

#### Token effect

终端输出按模型主动读取的部分计入（`readMaxBytes` 是单次上界，`scrollbackLines` 是每条会话保留的上界），provider 自身不产生任何额外 token。

#### KV Cache effect

不影响：这里没有任何进入请求前缀的内容。

## Known Limitations and Deferred Work

- **静默 ≠ 命令结束。** 落地条件只能观察终端的字节流与前台进程组，因此一条长时间不出声的命令与一个等待输入的子进程无法区分（见「落地条件」）。要更准确的判定，需要在沙箱里为每条命令划出可观察的边界（例如 shell 集成或进程级记账），而不是再加一个静默阈值。
- **会话随沙箱消失。** 沙箱被替换、被驱逐或按空闲退出后，会话不可恢复；模型看到的是一个已结束的会话，需要重新 `terminal_open`。
- **窗口大小不可变。** `rows`/`cols` 在打开会话时定下；改变尺寸需要 `container` 上的 resize 操作与宿主终端到运行时 CLI 的投递通道。
- **没有 `terminal_open` 的自动回收。** 空闲会话不会被 provider 主动关掉；回收靠 Agent 结束（会话随 Agent 关闭）与沙箱自身的空闲退出。按会话计时回收需要一条「谁还在用」的判据，而 `ctx.terminals` 的现有消费者没有提供它。
- **`cwd` 与 `env` 靠 `sh -c` 骨架实现。** `container` 的交互式会话不带工作目录与环境变量，因为那是运行时 CLI 自己的旗标；需要时自己包一层（本包的做法），代价是多一层 `sh`。
- **`type` 的默认值是部署事实。** `terminal_open` 的 `type` 是模型给的参数，其默认值取自 `tool-bash-persistent` 的 `backendType` 默认值（`shell`）；一个把本包注册成别的名字的部署必须同时给这两个工具配同一个 `backendType`。
