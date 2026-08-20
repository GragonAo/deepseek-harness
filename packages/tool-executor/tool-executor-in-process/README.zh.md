# @deepseek-ai/dsh-tool-executor-in-process

[English](README.md) | 中文

**`InProcessToolExecutor`**（`ctx.toolExecutor`）是[工具执行 seam](../tool-executor/README.zh.md) 的验证后端：它在同一 JavaScript realm 内内联运行一个工具执行体，因此挂载它之后工具行为与不挂载执行器的部署完全一致 —— 执行体在此运行，正如 seam 存在之前注册表派发它的方式。它是基线，**不是安全边界**：硬多租户边界是未来的 `container` 提供方。

## 行为

| 关注点 | 处理方式 |
|---|---|
| 内联执行体 | 直接运行 `request.body`，并解析其规范化值。 |
| 执行体拒绝 | 原样传播，使工具注册表的错误路径保留原始错误对象。 |
| 预中止信号 | 解析一个 `kind` 为 `abort` 的 `failure`。 |
| 缺失执行体 | 解析一个 `kind` 为 `execution-substrate` 的 `failure`（进程内世界没有内联执行体就无法解析 `toolId`）。 |

`execute()` 契约见 seam 的[服务 API](../tool-executor/README.zh.md#服务-apictxtoolexecutor)。

## 模型体验

无，因为本提供方只在进程内转发工具注册表的内联执行体，不新增任何模型可见内容或 token。

#### KV 缓存效果

无直接失效；本提供方不贡献请求 token。

## 已知限制与延后工作

- **无隔离** —— 同 realm 执行不是安全边界；硬多租户边界需要 `container` 提供方（延后）。
- **仅进程内** —— 没有内联执行体的请求无法解析 `toolId`，因此本提供方是基线，而非多租户执行世界。
