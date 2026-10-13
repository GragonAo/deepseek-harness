# @deepseek-ai/dsh-code-runtime-container

[English](README.md) | 中文

代码执行接缝（`ctx.codeRuntime`）的容器实现。每个 `run_code` 程序都在当前租户的容器内执行（经由 `ctx.containerRuntime`），而非宿主机 worker 线程；程序声明的 binding 通过一个短生命周期、带令牌鉴权的 HTTP 面桥接回宿主机，且只暴露当次请求的 binding。

## 隔离模型

隔离边界是租户容器，而非 JavaScript。程序以 `node --input-type=module -e <bootstrap>` 运行在容器内，容器只持有租户绑挂的 `/workspace` 与 `/tools`。即便程序逃逸出程序包装层（其全局 `console`/`process.stdout`/`process.stderr` 已被改写进日志捕获，但一个有资源的对手仍能触达更丰富的 Node API），它依然没有宿主机文件系统、环境变量或密钥：隔离来自容器本身。binding 调用——程序被提供的唯一宿主访问——通过 HTTP 桥接到一个按请求启动的服务，该服务以自有属性查找在当次请求的命名空间内解析，返回无损 JSON 或程序侧拒绝。

宿主桥接绑定一个临时端口（监听所有接口），并在 URL 路径携带每次运行独有的 256 位令牌，因此只有持有该 URL 的运行才能派发 binding。`container-docker` 提供者发布 `--add-host host.docker.internal:host-gateway`，使容器以该主机名触达宿主网关；Podman 部署则把 `config.hostBridge` 指向 `host.containers.internal`。

## 程序环境

容器 exec 只携带沙箱自身的事实：沙箱容器启动时的环境（平台身份变量）、`DSH_CODE_BRIDGE`（本后端的每次运行桥接 URL），以及由唯一所有者 [`ctx.shellEnv`](../../shell/shell-env/README.md) 通过 `collectSession()` 组装的受管 `DSH_*` 变量组（`DSH_HOME`、`DSH_SHELL`，以及处于 agent 驱动链内时的 `DSH_SESSION_ID`）。因此 `run_code` 程序读到的受管变量与同一沙箱里 `bash` 调用收到的一致，而本运行时不再自己维护任何变量列表。宿主机环境从不传入：运行时读的是 `ctx.get('shellEnv')`，所以没有挂载 shell-env 注册表的组合根本不注入受管变量组。

会话变量取自 ambient agent-initiator 作用域——agent loop 为当前驱动链建立的权威——绝不取自进程环境、沙箱继承来的 `DSH_*` 或请求本身：`CodeRunRequest` 不携带会话。没有 initiator 边界、或 agent 服务已释放时，该变量缺席。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `maxWallMs` | `600000` | 墙钟上限；超时即中止 exec 并上报 `timeout` |
| `maxOutputBytes` | `67108864` | 序列化「日志 + 结果」载荷的硬上限，容器内强制执行 |
| `hostBridge` | `host.docker.internal` | 容器触达宿主桥接所用的主机名 |

## 模型体验

间接经 [`dsh-tools`](../../core/tools/README.md) 的 Code Mode：当后端返回的精确完成值能放下时即原样呈现（否则给出明确的 `invalid-output` / `output-limit` 失败）到保留的 `run_code` 工具结果中，而 binding 流量与中间值仅存在于执行局部。

#### KV 缓存影响

保留的 `run_code` 结果追加到父请求，不会使既有 KV 缓存条目失效。

## 已知限制与后续工作

- 中止为尽力而为：容器 exec 面是单次调用，中止会停止宿主等待但不会硬杀容器内进程（随空闲容器回收），中止后产生的日志会丢失——不同于 worker-thread 后端逐条流式发送日志并终止 worker。
- 时间预算仅墙钟一项：容器无法像 worker 线程的 `computeMs` 那样计量程序的事件循环忙时。
- 捕获的 stdout/stderr 受容器内预算约束，容器 exec runner 对它捕获的原始流同样逐条加上界（保留末尾一段并报出截断）；两者都管不到的，是根本不到达这两根管道的那部分输出——重新打开容器自身 stdout 的程序写进运行时收集的容器日志，`run_code` 的结果显示不了它。
- 上面的受管变量组只是内置部分：`DSH_SESSION_JSONL` 这类 contributor 变量从 shell 工具执行解析，而 `run_code` 调用手里没有它，因此程序永远收不到这些变量。