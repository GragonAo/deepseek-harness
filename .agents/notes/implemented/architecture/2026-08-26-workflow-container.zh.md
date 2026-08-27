# Agent Note: 容器 workflow 经由 MessagePort↔HTTP 双工适配器

Status: implemented

[English](2026-08-26-workflow-container.md) | 中文

## 问题

多租户加固要求模型编写的编排脚本脱离 agent 宿主机运行。`workflow-worker-thread` 把脚本跑在宿主 worker 线程里，逃逸的脚本能读到宿主机文件、环境或密钥。容器世界已隔离 bash/fs/subprocess/code 工具； workflow 是最后一个宿主机执行面。

## 决策

发布 `@deepseek-ai/dsh-workflow-container`，一个 `WorkflowEngine` 提供者：完整复用 worker 侧运行时，只替换传输层。具体地：

- worker 侧运行时（`workflow-worker-thread/src/session.ts` 的 `runWorkerSession`，连同 `runtime.ts`/ `realm.ts`/`meta.ts`）本就对 `MessagePort` 做传输无关抽象，且有进程内覆盖测试；不改写。
- 容器入口（内联 worker 经标准输入馈入 `node --input-type=module -`，因为内联包超过 Linux 的单参数上限、无法用 `-e` 传递）构造一个符合 `MessagePort` 形约的 HTTP 适配器——`postMessage` 把 worker→host 消息 POST 到宿主桥，`on('message')` 对宿主桥长轮询宿主→worker 消息（Go/Cancel/ChildStarted/ChildStartError/ ChildSettled/ChildFailed/ChildDisposed）并分发——然后从 `DSH_WORKFLOW_INIT` 环境变量读 init 载荷（运行载荷无法与内联包共享标准输入），调用 `runWorkerSession(adapter, init)`。
- 宿主侧经 `ctx.containerRuntime.exec` 把运行放进租户容器，并架起每次运行独立、带令牌鉴权的双工桥（临时端口 + URL 令牌的形态同 `code-runtime-container` 的 binding 桥）：一个端点接收 worker POST（phase/ log/agent-start/agent-end + child-start/dispose RPC），第二个端点向 worker 的长轮询返回排队的 host→worker 消息。子代理 RPC 落在现有子代理接缝（`ctx.subagents.start`）上，与 worker-thread 宿主现有做法一致。
- 容器侧 worker 运行时与 HTTP 适配器被打包为一个自含 worker 模块（运行时读取一次并经标准输入馈入、其 init 经 `DSH_WORKFLOW_INIT`）；宿主透传 `hostBridge` 配置字段（默认 `host.docker.internal`），容器据此按名访问宿主网关。
- 共享线协议与 `renderThrown`/`ExecutionObserver` 上移到 `workflow-worker-thread` 的公开导出（容器提供者是它们的第二个消费者）。

## 备选方案

- 手写第二个容器专用 workflow 运行时：否决——重复约两千行并发/上限/取消/组合子逻辑，传输之外的隔离收益为零。
- 桥接子代理 RPC 与事件、但把脚本组合子留在宿主：否决——脚本体本身（`agent()` 调用之间的用户/mkdir/ 循环）正是必须离开宿主的代码。
- 用 WebSocket 取代长轮询：否决——两个纯 HTTP 端点上的长轮询无需新依赖，且与 code-runtime 桥的短时令牌形态一致。

## 后果

- `workflow-container` 提供 `ctx.workflowEngine`；`tool-workflow`/`tool-ralph` 原样消费它，租户因此保留单用户工作流面，且脚本在容器内执行。
- 多租户 bundle 挂载 `workflow-container` 并重新启用两个工具（web-app 已禁用宿主 `workflow-worker-thread` 行）；多租户 profile 中宿主 worker-thread 引擎保持关闭。
- 双工桥是新增攻击面；它每次运行令牌鉴权、端口临时，host→worker 队列有界、由 worker 长轮询排空。
- 相对 worker-thread 提供者文档化的三项差距（见包 README）：内联 worker 与其 init 分别经标准输入与一个环境变量绕过 Linux 的单参数/环境变量上限（若二者将来也超限则需改为容器内临时文件）、中止在一次性 exec 面上是尽力而为、长轮询给每条 host→worker 消息增加一次往返。

### 验证

- `packages/workflow/workflow-container/tests/runtime.spec.ts` 在本地 `node` 子进程内跑真实内联 worker、连真实进程内双工桥（`hostBridge: '127.0.0.1'`），覆盖完整线上交换（`ready`/`phase`/`log`/`result`）与完成值。
- `packages/workflow/workflow-container/tests/built-engine.e2e.ts` 在纯 Node 下启动构建后的引擎并驱动一次真实 `agent()` 往返（桥接子代理返回结构化值）至 `completed` 结果，外加 `dispose()`。
- `packages/bundle/multi-tenant/tests/multi-tenant.spec.ts` 断言 `workflow-container` 挂载、 `tool-workflow`/`tool-ralph` 重新启用，且宿主 `workflow-worker-thread` 行保持禁用。`verify-cordis-config`、构建与运行时闭包门通过。