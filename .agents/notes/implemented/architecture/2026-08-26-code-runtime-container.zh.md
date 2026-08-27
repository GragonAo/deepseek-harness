# Agent Note: 容器 code-runtime 让模型代码脱离宿主机执行

Status: implemented

[English](2026-08-26-code-runtime-container.md) | 中文

## 问题

多租户加固要求模型决定运行的代码永不落在 agent 宿主机上：worker-thread 的 `code-runtime` 后端把 `run_code` 程序跑在宿主机 worker 线程里，逃逸的程序能读到宿主机文件、环境或密钥。容器世界已经按租户隔离了 bash/fs/subprocess 工具；代码执行是剩下唯一的宿主机执行面。

## 决策

发布 `@deepseek-ai/dsh-code-runtime-container`，一个 `CodeRuntime` 后端（`isolation: 'container'`）：它把类型剥离后的程序以 `node --input-type=module -e <bootstrap>` 经 `ctx.containerRuntime.exec` 跑在当前租户容器内，并把程序声明的 binding 通过每次运行独立的 HTTP 面桥接回宿主机。隔离边界是容器而非 JavaScript：容器内的 bootstrap 把 `console`/`process.stdout`/`process.stderr` 改写进有序日志捕获，并在 stdout 输出一行 JSON 结果帧；但即便程序逃逸出这些垫片，它依然没有宿主机状态——因为它只曾在租户容器内运行。

宿主桥接是短生命周期的 `createBindingBridge`，绑定在监听所有接口的临时端口上；其 URL 携带每次运行独有的 256 位令牌，并以自有属性查找在当次请求的命名空间内解析调用（无损 JSON 参数与结果，失败即程序侧拒绝）。`container-docker` 发布 `--add-host host.docker.internal:host-gateway`，使容器触达宿主网关；配置项（`hostBridge`）给出容器内可达的宿主机名，默认 `host.docker.internal`（Podman 用户设为 `host.containers.internal`）。

## 备选方案

- 原样复用 worker-thread 的 `bootstrap.ts` 经 MessagePort 桥接：不可行——容器对宿主没有 MessagePort，只有一次性 `exec` 面与可达的宿主地址。
- 通过绑挂的 `/workspace` 下的文件信箱桥接 binding：避开宿主网关，但引入轮询延迟与每租户临时目录协议，隔离收益为零。
- 保留 worker-thread 后端并记录风险：否决——它把宿主密钥留在模型代码可控范围内，正是加固要消除的暴露。
- 仅复用现有 `POST /exec` 服务驱动整个运行：否决——该面是单次调用，无法承载程序向外的 binding 调用返回宿主。

## 后果

- 模型编写的代码不再跑在 agent 进程内；`run_code` 收敛到租户容器，补齐了「所有 AI 决定的执行都在工具/ 容器层」的要求。
- 宿主桥接与其令牌是唯一新增攻击面；它们短生命周期、端口临时、只解析在途请求的 binding。
- 相对 worker-thread 后端有两点已记录差距（见包 README）：中止为尽力而为（单次 exec 面无硬杀，中止后日志丢失），且时间预算仅墙钟一项（容器内无法计量忙时）。

### 验证

- `packages/code-runtime/code-runtime-container/tests/runtime.spec.ts` 在本地 `node --input-type=module -e` 子进程里跑真实 bootstrap、连真实进程内桥接（`hostBridge: '127.0.0.1'`），覆盖：可擦除 TypeScript 执行与有序捕获；binding 双向桥接加类型化拒绝；未声明成员的 TypeError；抛异常 → `exception`；非 JSON 完成值 → `invalid-output`；非零退出 → `worker-exit`。7 项测试通过。
- `packages/tenant/container-docker/tests/docker.spec.ts` 断言 `--add-host host.docker.internal:host-gateway` 参数；`packages/bundle/multi-tenant/tests/multi-tenant.spec.ts` 断言宿主 `code-runtime` 行被禁用、 `code-runtime-container` 被挂载。