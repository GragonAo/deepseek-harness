/**
 * 租户服务的可执行入口：`dsh-tenant`。
 *
 * 只做三件事：找到配置文件、按它启动组合、收到终止信号后释放组合。没有配置就不启动——
 * 端口、数据库、认证、沙箱这些值一个都不在代码里兜底。
 * @module @deepseek-ai/dsh-tenant-app/bin
 */

import { CONFIG_PATH_ENV, TenantAppConfigError, loadTenantAppConfig } from './config.ts'
import { createTenantApp } from './compose.ts'

/** 用法说明。 */
const USAGE = `用法：dsh-tenant --config <配置文件>

  --config <路径>   YAML 或 JSON 配置文件；也可以用环境变量 ${CONFIG_PATH_ENV}
  --help            打印这份说明
`

/** 解析命令行里我们认得的两个开关。 */
function configPathFrom(argv: readonly string[]): string | undefined {
  const flag = argv.indexOf('--config')
  if (flag >= 0) return argv[flag + 1]
  return process.env[CONFIG_PATH_ENV]
}

/** 启动服务，并在 SIGINT/SIGTERM 上优雅释放。 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(USAGE)
    return
  }
  const configPath = configPathFrom(argv)
  if (configPath === undefined || configPath.length === 0) {
    process.stderr.write(`缺少配置文件：请用 --config <路径> 或设置 ${CONFIG_PATH_ENV}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  const app = await createTenantApp(loadTenantAppConfig(configPath))
  process.stdout.write(`租户服务已启动：http://${loadHost(app)}:${app.port}\n`)

  let closing = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return
    closing = true
    process.stdout.write(`收到 ${signal}，正在释放租户服务\n`)
    void app.dispose().then(() => process.exit(0), (error: unknown) => {
      process.stderr.write(`释放失败：${(error as Error).message}\n`)
      process.exit(1)
    })
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown)
}

/** 日志里回显的监听地址。 */
function loadHost(app: Awaited<ReturnType<typeof createTenantApp>>): string {
  const host = app.ctx.get('webServer')?.host
  return host === undefined || host === '0.0.0.0' ? '127.0.0.1' : host
}

main().catch((error: unknown) => {
  const message = error instanceof TenantAppConfigError
    ? `配置有误：${error.message}`
    : `启动失败：${(error as Error).message}`
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
