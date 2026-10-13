// 独立的 tool-exec 容器入口。两个 provider 都把这一份长驻进程当成租户容器的执行世界：
// 它在所有接口上绑定被发布的容器端口并提供 `POST /exec`。被打包进来的 `tool-exec.mjs`
// （由 `../src/tool-exec.ts` 构建，唯一事实来源，单测在 tool-exec.spec.ts）提供
// `listenToolExecServer`。
import { listenToolExecServer } from './tool-exec.mjs'

const port = Number(process.argv[2] ?? '8642')
const host = process.argv[3] ?? '0.0.0.0'

// 空闲预算由宿主在启动时给出：provider 按配置的 `idleTimeoutMs` 注入 `DSH_TOOL_EXEC_IDLE_MS`，
// 容器据此看着自己有没有活干，超过预算就退出。给了值却不是正整数属于部署故障，直接拒绝启动，
// 而不是当作「没设预算」继续长驻——那会让一个本该被回收的沙箱悄悄留下来。
const raw = process.env.DSH_TOOL_EXEC_IDLE_MS
const idleTimeoutMs = raw === undefined || raw === '' ? undefined : Number(raw)
if (idleTimeoutMs !== undefined && (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0)) {
  throw new Error(
    `entry.mjs: DSH_TOOL_EXEC_IDLE_MS 必须是不小于 1 的整数毫秒，收到 '${String(raw)}'`,
  )
}

// 输出上界同样由宿主给出：provider 按配置的 `maxOutputBytes` 注入
// `DSH_TOOL_EXEC_MAX_OUTPUT_BYTES`，容器据此把每条输出流截到末尾一段——原始流是容器先攒满、
// 宿主才轮得到加界的，所以这条上界只能在这里生效。没给值就表示不加界，与空闲预算同一条规则；
// 给了值却不是正整数属于部署故障，直接拒绝启动，而不是悄悄继续无界攒原始流。
const rawOutput = process.env.DSH_TOOL_EXEC_MAX_OUTPUT_BYTES
const maxOutputBytes = rawOutput === undefined || rawOutput === '' ? undefined : Number(rawOutput)
if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)) {
  throw new Error(
    `entry.mjs: DSH_TOOL_EXEC_MAX_OUTPUT_BYTES 必须是不小于 1 的整数，收到 '${String(rawOutput)}'`,
  )
}

const { server } = await listenToolExecServer(port, host, { idleTimeoutMs, maxOutputBytes })

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
