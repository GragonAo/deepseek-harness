# @deepseek-ai/dsh-workflow-container

[English](README.md) | 中文

工作流能力接缝（`ctx.workflowEngine`）的容器实现。它把每次工作流中由模型编写的编排脚本放进所租用容器里执行——通过 `ctx.containerRuntime` 到达容器——而不是在宿主机 worker 线程里执行，并通过每次运行专属、带令牌鉴权的 HTTP 双工通道把脚本里的 `agent()` 调用桥接回 `ctx.subagents`。它原样复用了 worker-thread 引擎的整个 worker 侧运行时；只有传输层不同。

## 隔离模型

租户容器是安全边界，而不是 JavaScript。提供方把内联 worker 通过标准输入喂给 `node --input-type=module -`（`DSH_WORKFLOW_INIT` 携带本次运行的 init 载荷——内联包本身无法用 `-e` 传递，因为它超过了 Linux 的单参数大小上限），因此脚本——包括 `agent()` 调用之间的顶层代码——只运行在容器内，那里只有租户 bind-mount 的 `/workspace` 与 `/tools`。`agent()` 调用是脚本唯一被提供的宿主机访问通道，它通过 HTTP 桥接到一个每次运行专属的服务，该服务经由既有的子代理接缝（`ctx.subagents.start`）来解析，并沿用 worker-thread 宿主机驱动的那套准入、取消与子进程 RPC。

宿主桥在所有网卡上绑定一个临时端口，URL 路径里带每次运行专属的 256 位令牌，因此只有持有该 URL 的那次运行才能派发 `agent()` 调用或拉取宿主机到 worker 的消息队列。`container-docker` 提供方会发布 `--add-host host.docker.internal:host-gateway`，容器即通过该名称访问宿主网关；Podman 部署则把 `config.hostBridge` 指向 `host.containers.internal`。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `provider` | `spawn` | 子代理运行所用的 `ctx.subagents` 提供方（每次运行的 `subagentProvider` 会覆盖它） |
| `maxConcurrentAgents` | `0` | 并发 `agent()` 上限；`0` 自动解析为 `min(16, max(1, 逻辑核 - 2))` |
| `maxTotalAgents` | `1000` | 单次运行允许启动的 `agent()` 总数——失控循环的兜底上限 |
| `maxItemsPerCall` | `4096` | 单次 `parallel()`/`pipeline()` 调用接受的条目数 |
| `syncTimeoutMs` | `5000` | 脚本初始同步片断在容器内的 vm 超时 |
| `disposeGraceMs` | `5000` | 取消后到强制以 `cancelled` 收尾并中止进程前的宽限时间 |
| `hostBridge` | `host.docker.internal` | 容器访问宿主桥所用的主机名 |

## 模型体验

### 子代理请求

#### 模型所见

脚本每次 `agent()` 调用把提示词原样连同可选的模型或结构化输出 schema 发给子代理提供方。每个子代理看到的是该提供方自己的上下文；phase 与日志叙述只留在观察者事件里。

#### Token 影响

可能为多个彼此独立的子代理上下文付费，受 `maxConcurrentAgents`、`maxTotalAgents`、`maxItemsPerCall` 约束；它们从不直接并入父对话历史。

#### KV 缓存影响

与父请求缓存及兄弟子代理彼此独立。每个子代理只能复用自己提供方、模型、提示词、schema 下逐字节一致的前缀；其后续历史只增不改。

### 父工具结果（间接）

#### 模型所见

经 `dsh-tool-workflow`，成功只在该消费方的包装里暴露物化后的最终 JSON 值与子代理数量；中间子代理输出仅供脚本读取，父模型不可见。

#### Token 影响

本引擎对父对话产生零直接 token。最终结果大小由工具消费方封顶，并保留至被压缩。

#### KV 缓存影响

只增不改；新可见内容沿用可复用请求前缀，不会使既有 KV 缓存条目失效。

## 已知限制与待办

- 内联容器 worker 通过标准输入馈入（`node --input-type=module -`）、其 init 通过 `DSH_WORKFLOW_INIT` 环境变量传入，因为单个 `-e` argv 项不能超过 Linux 的单参数大小上限；若 init 载荷将来也超过环境变量上限，二者都必须改为容器内临时文件。
- 中止是尽力而为：容器 exec 面是一次性的，因此中止只是让宿主机不再等待，并不会硬杀容器内进程（它随空闲容器被回收），且中止时在途的 worker 消息会被丢弃——不像 worker-thread 后端那样会终止 worker。
- 长轮询使每条宿主机到 worker 的消息（Go/Cancel/子进程 RPC）多一个往返，相比 worker-thread 的进程内通道有额外延迟；对观察者事件和 `agent()` 调用可接受，但不适合脚本内的热循环。