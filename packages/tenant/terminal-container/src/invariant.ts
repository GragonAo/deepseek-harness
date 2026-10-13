/**
 * 本包自己的不变量伴随件（`@deepseek-ai/dsh-terminal-container`）。
 * @module @deepseek-ai/dsh-terminal-container/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-terminal-container'

/** Cordis 伴随插件名。 */
export const name = 'terminal-container-invariant'
/** 伴随件占位之前需要的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 本包没有可断言的运行时关系。会话状态（回滚缓冲、发送结算、退出结果）都是
 * 每条会话自己的私有实现状态，本包不发布独立的事件流或快照；沙箱侧的状态归容器运行时所有，本包只能读。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变量伴随件。
 * @param ctx - 带不变量服务的 Cordis 上下文。
 * @returns 安装成功后返回注销函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
