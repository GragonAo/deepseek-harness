# 第 2 章 · Cordis 地基

> 阶段：0 → 会用。读完你能看懂一个 dsh 插件长什么样、为什么「挂上去」就能跑。

Cordis 是 dsh 底层的插件框架，以源码形式 vendored 在 [`vendor/`](../vendor/README.md) 下，并以 `@deepseek-ai/cordis` 的 scope 发布。dsh 的一切插件机制都建立在它上面，所以这一章是地基。官方入门见 [`docs/cordis-primer.md`](../docs/cordis-primer.md)，动手教程见 [`docs/cordis-tutorial/index.md`](../docs/cordis-tutorial/index.md)；本章做浓缩导读并标注源码落点。

## 五个核心概念

来自 [`docs/cordis-primer.zh.md`](../docs/cordis-primer.zh.md#五个核心概念)，这是全部心智负担：

1. **插件是实现 Service 的对象。** 它可以是一个带可选 `inject` 与 `apply(ctx)` 字段的函数，也可以是一个 `Service` 子类，生命周期由 Cordis 挂载到当前上下文。
2. **上下文是服务的容器。** 一个服务占据一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`），其他插件通过 key 查找服务，而非 import 具体实现。
3. **通过 `inject` 声明服务依赖。** 插件声明所需服务后，会等待这些服务就绪才启动；加载顺序由服务依赖表达，不靠手动编排。
4. **类型化事件用于通信。** 服务通过 TypeScript 声明合并注册事件名，以 `emit` / `waterfall` / `parallel` / `serial` 分发。
5. **注册是可逆的副作用。** 提示词片段、工具 schema、适配器、provider、监听器都通过 `ctx.effect()` 或 `ctx.on()` 安装，reload/teardown 时自动撤销。

## 服务与上下文

在 dsh 里，你几乎永远不 `new` 一个核心对象，而是从 `ctx` 上取；依赖用 `inject` 声明，等它们就绪才启动：

```ts
// 一个函数插件：inject 声明依赖服务，apply 在挂载时执行
export const inject = ['tools']

export function apply(ctx: Context) {
  // 从 ctx 上取服务、做注册；返回的 disposer 卸载时回收
  ctx.tools.register(/* ToolDefinition */)
  ctx.on('session/event', (session, event) => { /* 观察 */ })
}
```

服务是 `Service` 子类，默认导出服务类（这与函数插入式插件不同——见 [`packages/AGENTS.md`](../packages/AGENTS.md) 中「插件导出」规则：服务包默认导出服务类；函数插件具名导出 `name`/`inject`/`Config`/`apply`）。

## 事件分发的四种模式

每个事件有且仅有一种分发模式，只能通过对应方法分发（[`docs/cordis-primer.md`](../docs/cordis-primer.md#dispatch-modes)）：

| 模式 | 是否 await | 顺序 | 返回值 |
|---|---|---|---|
| `emit` | 否 | 监听器按注册顺序观察 | 无 |
| `waterfall` | 否 | 监听器按注册顺序观察 | 有 |
| `parallel` | 是 | 所有监听器并行 | 无 |
| `serial` | 是 | 监听器按注册顺序 | 有 |

在 dsh 里你会反复遇到：`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute` 都是 **waterfall**；`agent/turn-stopping` 是 **serial**；绝大多数会话/生命周期事件是 **emit**。

## Waterfall 语义（重点）

`ctx.waterfall` 是环绕中间件：监听器收到 `(...args, next)`，调用 `next()` 才会执行下游监听器，下游返回值经 `next()` 返回给当前包装层，可被包装后继续向外返回；**不调用 `next()` 直接返回则短路**（[`docs/cordis-primer.md`](../docs/cordis-primer.md#cordis-waterfall-semantics)）。

两条实战纪律：

- **协作式监听器**：修改共享的请求/决策对象，然后 `next()` 委托。
- **单决策事件的监听器**：有决策权时可不调 `next()` 直接返回（短路是设计意图）；只做标注/观察的监听器必须 `next()`。

这条纪律直接对应 dsh 的一个大坑：瀑布监听器**必须调用 `next()`** 委托，否则短路整条链（根 [`AGENTS.md`](../AGENTS.md#conventions) 明文强调）。

## 注册是副作用，且可逆

```ts
ctx.effect(() => {
  const dispose = someRegistry.register(myContribution)
  return dispose // 卸载时调用，回收贡献
})
ctx.on('some/event', handler) // Cordis 自动把监听器绑定到作用域，卸载即回收
```

「注册返回 disposer」是 dsh 的通用约定（registry 的 `register()` 返回 disposer）。HMR（热替换）安全性就建立在「dispose 之后贡献确实消失」这条不变式上，[第 15 章](15-engineering-practices.md)会展开测试它。

## Loader 配置

`cordis.yml` 是这个框架的「入口文件」。它的两个关键机制（[`docs/cordis-primer.md`](../docs/cordis-primer.md#loader-configuration)）：

- `!!js` 表达式节点由 `@deepseek-ai/cordis-plugin-include` 解析；条目的 `config` 基于插件上下文（`ctx.serviceName`）插值，`disabled` 基于 loader 上下文插值。
- 需要环境条件选择插件时，用 **overlay**（叠加层）而非在 YAML 里写逻辑。

注意 dsh 的 `cordis.yml` 里 `!!js` 是**两个叹号**，`!js` 是错的（[`AGENTS.md`](../AGENTS.md#secrets--env)）。

## 落地位置

- 框架源码：`vendor/cordis/`（`Context`、`Service`、`Fiber`、事件）。
- 改名映射：上游 `cordis` → 发布 `@deepseek-ai/cordis`，见 [`docs/rescope.md`](../docs/rescope.md)。
- 框架继承的 `ctx` API 参考：[`docs/cordis-api/inherited.md`](../docs/cordis-api/inherited.md)（`ctx.get`、`ctx.effect`、`ctx.on`、`ctx.waterfall` 等）。

## 小结

记住这五样就够往下读：**插件 = 对象、上下文 = 容器、inject = 等依赖、事件 = 通信、effect = 可逆副作用**。第 3 章开始，我们把 dsh 自己的插件树叠在这五个原语上。