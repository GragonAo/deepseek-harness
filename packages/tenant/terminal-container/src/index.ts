/**
 * 租户沙箱里的持久终端：把容器运行时的交互式会话注册成终端接缝的一个 PTY 后端。
 * @module @deepseek-ai/dsh-terminal-container
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TerminalBackend, TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal'
import { type Config, type ResolvedConfig, resolveConfig, validateConfig } from './config.ts'
import { ContainerTerminalSession } from './session.ts'

export { Config } from './config.ts'
export type { Config as TerminalContainerConfig } from './config.ts'

/** Cordis 插件名。 */
export const name = 'terminal-container'
/** 需要的服务：终端注册表，以及给出交互式会话的容器运行时。 */
export const inject = ['terminals', 'containerRuntime']

/**
 * 把一个值写成 POSIX shell 的单个词。
 * @param value - 任意文本，包括含单引号或换行的文本。
 * @returns 单引号包裹、可安全拼进 `sh -c` 载荷的词。
 */
function quote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/**
 * 构造 `sh -c` 的载荷：先落地到工作目录，再带上一组终端环境变量，最后把 shell 自己 exec 上去。
 *
 * 工作目录和环境变量在这里给，而不是交给容器 CLI：`docker exec` 有 `-w`/`-e`，`kubectl exec` 没有，
 * 而这条载荷是两者共用的。`exec` 让 shell 顶替这条命令本身，于是终端的前台进程组从头到尾就是 shell
 * 自己的会话，中途不会多出一个壳进程来抢终端。
 * @param spec - 注册表交来的会话请求。
 * @param config - 已校验的配置。
 * @returns 交给 `sh -c` 的载荷。
 */
function shellCommand(spec: TerminalBackendSpawnSpec, config: ResolvedConfig): string {
  const cwd = spec.cwd ?? config.cwd
  // 与 terminal-bash 同一组环境变量：TERM 落在哑终端上（沙箱镜像里 TERM 本来就没有值），
  // 分页器一律落成 cat，免得交互式命令在等一个不会有人按的分页键。
  const environment: Record<string, string> = {
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    DSH_SHELL: '1',
    DSH_SESSION_ID: spec.owner.id,
    DSH_PTY_SESSION_ID: String(spec.sessionId),
  }
  const assignments = Object.entries(environment)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(' ')
  return [
    `cd ${quote(cwd)} || { printf 'dsh: cannot enter %s\\n' ${quote(cwd)} >&2; exit 126; }`,
    `${assignments} exec "$0" "$@"`,
  ].join('\n')
}

/** 一个沙箱内 shell 的 PTY 后端。 */
class ContainerTerminalBackend implements TerminalBackend {
  readonly type: string

  /**
   * @param ctx - 带 `containerRuntime` 的上下文。
   * @param config - 已校验的配置。
   */
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {
    this.type = config.backendType
  }

  /**
   * 在租户沙箱里开一个交互式 shell 会话。沙箱由容器运行时按调用发生时的环境钉住，
   * 会话发布之后不再重解析，所以调用方之后在别的请求里读、写、发信号都还落在同一个沙箱上。
   *
   * 这里没有回滚步骤：唯一可能失败的启动动作在容器运行时内部，而它自己会清掉拉起的容器 CLI
   * （见 `@deepseek-ai/dsh-container-transport` 的交互式会话）。本后端在会话返回之后才开始记状态。
   * @param spec - 注册表交来的会话请求，含发起它的那个 Agent。
   * @returns 已发布的会话，`motd` 是建立时会话已经打出来的那一小段输出。
   * @throws 沙箱起不来、命令没能在期限内接管终端，或工作目录不存在时。
   */
  async spawn(spec: TerminalBackendSpawnSpec): Promise<ContainerTerminalSession> {
    spec.signal?.throwIfAborted()
    const session = await this.ctx.containerRuntime.openPty({
      command: '/bin/sh',
      args: ['-c', shellCommand(spec, this.config), this.config.shellPath, ...this.config.shellArgs],
      rows: this.config.rows,
      cols: this.config.cols,
      maxOutputBytes: this.config.scrollbackMaxBytes,
      disposeGraceMs: this.config.disposeGraceMs,
      // 未发布的会话才谈得上取消；没有取消信号时这个字段就不该出现。
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
    const terminal = new ContainerTerminalSession(session, this.config)
    terminal.initialize()
    return terminal
  }
}

/**
 * 注册沙箱终端后端。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置；类型名、shell、尺寸与各个上界都在这里定，不在会话里硬编码。
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  validateConfig(resolved)
  ctx.terminals.registerBackend(new ContainerTerminalBackend(ctx, resolved))
}
