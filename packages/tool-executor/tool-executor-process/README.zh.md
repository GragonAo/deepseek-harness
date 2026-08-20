# @deepseek-ai/dsh-tool-executor-process

[English](README.md) | 中文

**`ProcessToolExecutor`**（`ctx.toolExecutor`）把每个工具主体放进它自己的执行 worker —— 一个跑 stdio NDJSON 协议的 fork 出来的 Node 进程 —— 使主体不再与 session、agent、凭据状态并排运行。它是[tool-execution seam](../tool-executor/README.zh.md) 之后第一次真正的 agent 层/执行层拆分：worker 按工具稳定的控制面 `name` 在自己的主体注册表里解析调用，因此没有任何函数跨过进程边界。裸进程仍是 containment 而非安全边界 —— 硬多租户边界是未来的 `container` 提供方。

## 行为

| 关注点 | 处理方式 |
|---|---|
| 主体解析 | worker 侧按 `request.name` 解析；`request.body` 永不跨过边界。 |
| worker 生命周期 | 一个常驻 worker 服务多次调用；disposal 终止它并等待其退出。 |
| 预中止信号 | 不接触 worker 即解析 `kind` 为 `abort` 的 `failure`。 |
| 运行中中止 / 超时 | 转发 `abort` 帧；worker 精确取消该调用并报告 `abort`。 |
| worker 死亡 | 把每个在途调用解析为 `kind` 为 `execution-substrate` 的 `failure`。 |

`execute()` 契约见 seam 的[服务 API](../tool-executor/README.zh.md#服务-apictxtoolexecutor)。

## 模型体验

无，因为本提供方只把工具注册表的执行体调入 worker 进程，不新增任何模型可见内容或 token。

#### KV 缓存效果

无直接失效；本提供方不贡献请求 token。

## 已知限制与延后工作

- **仅为 containment，非隔离** —— 裸进程共享宿主内核；硬多租户边界需要 `container` 提供方（延后）。
- **仅演示主体** —— 首个跨进程阶段内置演示主体注册表（`exec:pid`、`exec:echo`、`exec:wait`）；按 `name` 挂载第一方执行世界工具（`read`、`glob`、……）是下一阶段。
- **无输出字节上限** —— worker 在无大小约束下报告主体值；上限应设在执行世界配置里。