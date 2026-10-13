/**
 * 本包自己的运行时不变式伴随插件。
 * @module @deepseek-ai/dsh-tenant-app/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tenant-app'

/** 伴随插件在 Cordis 里的名字。 */
export const name = 'tenant-app-invariant'
/** 必须先有不变式服务，伴随插件才能为这个包预留归属。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 本包是租户栈的启动入口，不持有自己的可变数据，也没有自己拥有的事件关系
 * 可断言——配置校验是一次纯函数调用，组合只是把清单上的插件挂到它自建的 Context 上，挂完就把
 * 所有权交给那些插件，本包不再持有注册表、缓存或事件流。装配对不对由启动当场判定（`assertLoaded`
 * 逐个等 fiber 结束、`assertMountedServices` 核对必在服务），组合行为由 `tests/app.spec.ts` 对着
 * 真实组合断言；在这里重述只会得到一份会漂的副本。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变式伴随插件。
 * @param ctx - 带不变式服务的 Cordis 上下文。
 * @returns 注册成功后的释放函数。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
