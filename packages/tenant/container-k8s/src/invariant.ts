/**
 * @deepseek-ai/dsh-container-k8s 自有的不变式伴随插件。
 * @module @deepseek-ai/dsh-container-k8s/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-container-k8s'

/** Cordis 伴随插件的名字。 */
export const name = 'container-k8s-invariant'
/** 该伴随插件认领本包所有权之前必须先就位的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 值得检查的关系是「活着沙箱 Pod 上的 dsh.dev/spec-fingerprint 注解，
 * 等于本进程对同一个 (租户, 用户) 会算出的摘要」。读它需要一次集群往返，
 * 而 installer 一旦去读，就等于对被检查的部署做了动作。
 * provider 改为在 ensureSandbox 里每次调用都断言这个相等关系——那里两个值本来就在手上。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变式伴随插件。
 * @param ctx - 携带不变式服务的 Cordis 上下文。
 * @returns 安装成功后返回该注册项的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
