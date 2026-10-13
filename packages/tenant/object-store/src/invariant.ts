/** `@deepseek-ai/dsh-object-store` 的包不变量伴生插件。 @module @deepseek-ai/dsh-object-store/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-object-store'
/** Cordis 伴生插件名。 */
export const name = 'object-store-invariant'
/** 预留包归属之前必须就位的服务。 */
export const inject = ['invariants']
/**
 * No runtime invariant: 本包不拥有会话事件、服务状态或跨插件关系——它的持久输出是对象存储里的
 * 一个对象，而该对象的键与公开地址由发布结果本身报告，没有第二份需要与之一致的内部状态。
 */
const install: InvariantInstaller = () => {}
/**
 * 注册包不变量伴生插件。
 * @param ctx - 承载不变量服务的上下文。
 * @returns 注销函数。
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
