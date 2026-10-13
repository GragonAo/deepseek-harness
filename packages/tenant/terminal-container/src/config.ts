/** 容器后端 PTY 的已校验配置。 */

import z from '@deepseek-ai/schemastery'

/** 插件公开配置。 */
export interface Config {
  /** 后端注册类型（默认 `shell`：终端工具与 `tool-bash-persistent` 默认要的就是这个名字）。 */
  backendType?: string
  /** 沙箱里的交互式 shell 可执行文件。 */
  shellPath?: string
  /** shell 参数。 */
  shellArgs?: string[]
  /** 未指定工作目录的会话在沙箱里的落地目录。 */
  cwd?: string
  /** 终端行数。 */
  rows?: number
  /** 终端列数。 */
  cols?: number
  /** 保留的最大逻辑行数。 */
  scrollbackLines?: number
  /** 保留的最大 UTF-8 字节数，同时也是容器侧保留输出的上界。 */
  scrollbackMaxBytes?: number
  /** 一次读或一次结算视图返回的最大字节数。 */
  readMaxBytes?: number
  /** 观察输出的轮询间隔（只读本地缓冲，不产生沙箱往返）。 */
  pollIntervalMs?: number
  /** 静默多久后判定「对方在等输入」。 */
  idleSilenceMs?: number
  /** 一次发送的绝对等待上界。 */
  timeoutMs?: number
  /** 会话结束时先 TERM、超过这个宽限才升级到 KILL 的等待时长。 */
  disposeGraceMs?: number
}

/** 补齐默认值后的配置。 */
export type ResolvedConfig = Required<Config>

/** 默认 shell 可执行文件：镜像里的 bash（`/bin/sh` 是 dash）。 */
export const DEFAULT_SHELL_PATH = '/bin/bash'
/** 默认 shell 参数：交互式、不读 profile，与 `terminal-bash` 逐字相同。 */
export const DEFAULT_SHELL_ARGS = ['--noprofile', '--norc', '-i']
/** 默认工作目录：沙箱里租户工作区的挂载点。 */
export const DEFAULT_CWD = '/workspace'

const DEFAULTS: ResolvedConfig = {
  backendType: 'shell',
  shellPath: DEFAULT_SHELL_PATH,
  shellArgs: DEFAULT_SHELL_ARGS,
  cwd: DEFAULT_CWD,
  rows: 40,
  cols: 160,
  scrollbackLines: 10_000,
  scrollbackMaxBytes: 4 * 1024 * 1024,
  readMaxBytes: 256 * 1024,
  pollIntervalMs: 50,
  idleSilenceMs: 3_000,
  timeoutMs: 30_000,
  disposeGraceMs: 3_000,
}

/**
 * 补齐配置默认值。默认值是这一步显式完成的，不在会话里散落 `??` 回落：
 * Schemastery 会把缺省的可选数组物化成 `[]`，所以空数组同样算「没写」。
 * @param config - 插件配置。
 * @returns 每个字段都有值的配置。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...DEFAULTS,
    ...config,
    shellArgs: config.shellArgs !== undefined && config.shellArgs.length > 0 ? config.shellArgs : DEFAULT_SHELL_ARGS,
  }
}

/** 插件对外暴露的 Schemastery 配置。 */
export const Config: z<Config> = z.object({
  backendType: z.string().default(DEFAULTS.backendType),
  shellPath: z.string().default(DEFAULTS.shellPath),
  shellArgs: z.array(z.string()).required(false),
  cwd: z.string().default(DEFAULTS.cwd),
  rows: z.number().default(DEFAULTS.rows),
  cols: z.number().default(DEFAULTS.cols),
  scrollbackLines: z.number().default(DEFAULTS.scrollbackLines),
  scrollbackMaxBytes: z.number().default(DEFAULTS.scrollbackMaxBytes),
  readMaxBytes: z.number().default(DEFAULTS.readMaxBytes),
  pollIntervalMs: z.number().default(DEFAULTS.pollIntervalMs),
  idleSilenceMs: z.number().default(DEFAULTS.idleSilenceMs),
  timeoutMs: z.number().default(DEFAULTS.timeoutMs),
  disposeGraceMs: z.number().default(DEFAULTS.disposeGraceMs),
})

/**
 * 断言每个生效的数值字段都是正的安全整数，且各项上界彼此相容。
 * @param config - 补齐默认值后的配置。
 * @returns 把入参收窄成已校验的配置。
 */
export function validateConfig(config: Config): asserts config is ResolvedConfig {
  const resolved = config as ResolvedConfig
  if (resolved.backendType.trim().length === 0) throw new Error('terminal-container: backendType must be non-empty')
  if (resolved.shellPath.trim().length === 0) throw new Error('terminal-container: shellPath must be non-empty')
  if (resolved.cwd.trim().length === 0) throw new Error('terminal-container: cwd must be non-empty')
  if (resolved.shellArgs.length === 0) throw new Error('terminal-container: shellArgs must not be empty')
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`terminal-container: ${name} must be a positive safe integer`)
    }
  }
  if (resolved.readMaxBytes > resolved.scrollbackMaxBytes) {
    throw new Error('terminal-container: readMaxBytes must not exceed scrollbackMaxBytes')
  }
  if (resolved.timeoutMs < resolved.idleSilenceMs) {
    throw new Error('terminal-container: timeoutMs must be at least idleSilenceMs so silence can settle a send before its deadline')
  }
}
