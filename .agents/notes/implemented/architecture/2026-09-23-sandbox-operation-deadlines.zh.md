# Agent Note：沙箱与委派等待都带上期限

Status: implemented

[English](2026-09-23-sandbox-operation-deadlines.md) | 中文

## 问题

在多租户部署中，一次前台委派把父会话永久挂住：事件数不再增长，既没有工具结果也没有轮次结束，也没有任何错误上报；只有重启宿主进程才能恢复。这条链路上处处没有期限，而且其中一环还把失败缓存了下来。

`container-docker` 在查看调用方信号之前就用 `await this.ensure(...)` 解析 (租户, 用户) 运行时，因此其下方的 `signal.aborted` 检查从未执行，已被中止的调用照样会启动容器。`ensure()` 把启动 promise 缓存进一张表，并且只在该 promise 落定时删除条目，因此一次永不落定的启动就会在宿主进程的余生里废掉这个 (租户, 用户) key——该主体之后的每次工具调用都并入同一个挂起的 promise。容器 CLI 调用、整次启动、tool-exec 往返都没有期限：`runCli` 只在子进程 `close` 时兑现，其「中止即 SIGKILL」的监听器只在传入信号时才注册，而从来没有信号被传进去。tool-exec 的 `fetch` 传的是 `signal: null`，这等于明确声明该请求没有期限。

下游也无法补偿。shell 自带的 120 秒期限只能到达那次从未发出的 `fetch`，因为 provider 还卡在 `ensure` 里。在返回链路上，进程内驱动器等待 `child.whenIdle()` 时没有任何上界，而 `tool-subagent` 没有声明 `timeoutMs`，因此 [`guard/timeout-policy`](2026-07-07-tool-call-timeout-policy.md) 根本没有为这次调用装上 `TOOL_TIMEOUT`。

## 决策

现在有三层各自结束下层无法结束的等待。

`container-docker` 的 `Config` 新增 `cliTimeoutMs`（默认 `60000`）、`startTimeoutMs`（默认 `180000`）和 `transportTimeoutMs`（默认 `600000`），并把就绪等待原本写死的常量变成 `readyTimeoutMs`（默认 `10000`）与 `readyPollMs`（默认 `30`）。每次容器 CLI 调用、整次冷启动、以及 tool-exec 往返都跑在 `dsh-timeout` 的 [`deadline`](../../../../packages/util/timeout/README.md) 之下；`runner.ts` 不变，因为它既有的「中止即杀」路径需要的正是传入信号。

超过 `startTimeoutMs` 的启动会在抛错前清掉自己的 `starting` 条目并丢弃运行时。这就是本次事故的修复：失败的启动绝不能被缓存。`exec()` 还把 `await ensure(...)` 纳入调用方的融合期限之内，因此已中止或已过期的调用不再等待进行中的启动，而是直接逃出；启动本身仍会继续服务于共用同一 key 的其他调用方。

超过上界的 tool-exec 往返不会被重试。既有的替换规则假定「拒绝」意味着命令从未执行——这对传输或协议失败成立，对超时不成立：命令可能仍在容器里运行。

`subagent-in-process-driver` 新增 `Config` 与 `settleTimeoutMs`（默认 `3600000`），两个进程内提供方都在各自的配置里公开该字段。`whenIdle()` 不可取消，因此驱动器让它与期限赛跑；到期时取消子 agent，并以 `aborted` 结束该运行，同时给出带该上界的诊断，从而保证 `result` 与等待它的 `dispose()` 一定落定。该期限不带上游信号：调用方的取消已经通过运行自身的中止监听器到达子 agent，只有驱动器自身的到期才意味着子 agent 停止响应。

`tool-subagent` 新增 `foregroundTimeoutMs`，写入工具定义的 `timeoutMs`。声明预算才会让超时策略装上 `TOOL_TIMEOUT`；该字段没有 schema 默认值，因此省略它的部署保持今天这种无上界的调用。

## 考虑过的替代方案

- **把调用方信号传给每次 CLI 调用，仅靠取消兜底**：否决。没有任何东西会取消一个自身已经卡死的调用方，而本次上报的挂起根本没有任何取消者。
- **到期时拒绝启动 promise 但保留缓存条目**：否决。被缓存的 promise 恰恰就是废掉该 (租户, 用户) key 的东西。
- **让 tool-exec 往返与期限赛跑，而不是转发信号**：否决。`fetch` 本来就遵守信号，赛跑反而会抢先于调用方今天上报的传输错误。
- **给子 agent 循环设界，而不是给它等待设界**：否决。驱动器不拥有 agent 循环；它拥有的是取消子 agent 这一操作。
- **在每个插件里写死期限**：被「禁止硬编码可调参数」规则否决——宿主的容器守护进程或一次委派可以花多久是因部署而异的，所以每一项都是经过校验的 `Config` 字段。

## 后果

- 多租户部署在 `container-runtime` 上设置 `cliTimeoutMs: 60000`、`startTimeoutMs: 180000`、`transportTimeoutMs: 600000`、`readyTimeoutMs: 10000`、`readyPollMs: 30`，并在两个 `tool-subagent` 实例上设置 `foregroundTimeoutMs: 1800000`。`transportTimeoutMs` 覆盖命令在容器内的执行时间，因此它高于那些更早结束调用的面向模型期限（shell 120 秒、委派 30 分钟）。
- 卡死的容器守护进程现在的代价是一次失败的工具调用，以及下次调用时重新启动，而不再是把该主体的每次工具调用都停到宿主重启为止。
- 在 `docker run -d` 之后失败的启动仍会在同名容器下留下一个容器，直到下次启动清除它；这与任何失败启动的既有行为一致，清除它的是下次启动的 `rm -f`。
- 交叉链接：本次保留的替换规则见[exec 失败时的沙箱替换](2026-09-22-sandbox-replacement-on-exec-failure.md)；期限原语与消费已声明 `timeoutMs` 的策略分别见[超时期限库](2026-07-06-timeout-deadline-library.md)与[工具调用超时策略](2026-07-07-tool-call-timeout-policy.md)。

### 验证

- `packages/tenant/container-docker/tests/docker.spec.ts` 新增五个用例：永不返回的 CLI 调用在 `cliTimeoutMs` 内失败；卡死的启动在 `startTimeoutMs` 内失败且下一次 `exec` 会再次调用 CLI（缓存 promise 的闸门）；永不回应的 tool-exec 往返在 `transportTimeoutMs` 内失败；已被中止的调用不启动任何东西；启动挂起期间的中止能直接逃出。19 个测试全绿。
- `packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts` 断言 `settleTimeoutMs: 50` 下 `'hang'` 子 agent 以 `aborted` 落定、诊断中包含该上界，并且仍能 dispose。该包 59 个测试全绿。
- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 断言所注册工具的 `timeoutMs` 等于配置的 `foregroundTimeoutMs`，未配置时为 undefined。该包 73 个测试全绿。
