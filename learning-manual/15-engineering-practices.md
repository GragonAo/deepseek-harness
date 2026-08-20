# 第 15 章 · 工程规范与测试

> 阶段：精通。读完你能按仓库标准提交一个不会被 CI 打回的、质量到位的能力扩展。参考：[`AGENTS.md`](../AGENTS.md)、[`docs/testing.md`](../docs/testing.md)、[`docs/defensive-patterns.md`](../docs/defensive-patterns.md)、[`docs/development.md`](../docs/development.md)。

## 类型安全与文档纪律

- 全仓 `strict: true` + `noImplicitAny`；每个 `any` 都要解释为什么无法收窄。
- **无运行时校验的信任边界**：同进程类型化边界信 TypeScript，不要在 parser/config、队列、模型/工具 JSON、持久/文件、worker、进程、wire 边界之外加多余校验。
- **编译器面显式**：每个包一个 aggregate（`api/remotes` 除外）；仓库级程序 seed 一份 face 配置，绝不用根 solution。
- **源平面 vs 制品平面**：静态门禁与测试经 tsconfig `paths` 解析到 `src` 且在干净树上通过；消费 `lib/` 的门禁要声明这个依赖。
- **测试只描述行为，不描述正确性**；改行为就改测试并说明原因。

## 分层测试

四层（[`docs/testing.zh.md`](../docs/testing.zh.md#层级)）：

1. **单元测试**（`pnpm run test`）：vitest。每个 registry 都有 HMR 安全测试（dispose 贡献的 fiber 并断言回收）。优先边界、错误路径、事件顺序、并发竞态、约定回归。
2. **覆盖率门禁**（`pnpm run test:coverage`）：`packages/*/*/src` 每文件 100%。行覆盖是必要非充分；未覆盖的行常常是门禁标记出的死代码，应删而非补测。
3. **真实 API e2e**（`pnpm run test:e2e`）：带密钥，无密钥自动跳过。最高价值是冒烟测试——真启动样例、发一条提示词、检查外部世界。
4. **快照**（`pnpm run test:snapshot`）：无密钥预期输出。ACP 场景回放录制会话并对归一化 JSON-RPC + 重持久化日志做 diff；`test:snapshot:record` 重录，`test:snapshot:refresh` 复用回放输入只刷预期。

外加 **Web 浏览器快照**（`test:web`，Linux 必选门禁）。

## 三个核心理念

- **验证外部世界，而非自我报告**：e2e 断言重新跑命令/重新读文件，别对 agent 自述做关键词命中（那会让作弊 agent 通过）。
- **优先真实实现而非 mock**：只 mock 高代价/不确定边界（LLM 适配器、网络、时钟），下游全真。桥接工具测试用脚本化 mock 模型 + 真实工具（如 `makeBridgeHarness({ withBash: true })` 真跑 `echo`）。
- **测真实入口路径**：产品可见插件必须有非单元的真实组合测试——Loader + app/process 启动测试专用 `cordis.yml`。`bin` 跑的是构建后 `lib/bin.js`（暴露 tsx 掩盖的失败：结算竞态、模块解析、被吞的加载失败）。

## 何时需要快照测试

每项非平凡的模型可见、协议可见、人类可见变更，同一 PR 必须加/改无密钥场景。两个 SDK 各自投影 agent loop / 会话生命周期 / `SessionEventMap`，改其一就要同时改两者：TypeScript 客户端在 `examples/jsonrpc-agent/tests/snapshots/`，Python 客户端在 `scripts/snapshots/python-sdk-single-exe/`。

## 防御性模式

写生命周期/并发/子进程/teardown 代码前必读 [`docs/defensive-patterns.md`](../docs/defensive-patterns.md)，七条规则已在[第 4 章「补充」](04-design-philosophy.md#defensive-patterns)列出。要背的两条：

- **正交结果独立上报**（超时 vs 信号 vs 退出码，互不嵌套）。
- **dispose 必须完全停稳**（等子进程退出、先关监听/通知注册表）。

## 机检门禁体系

`pnpm run doc-sync` 是全部文档门禁的入口（叶子清单在 `scripts/run-gates.ts`），典型包括：

- `verify-md-wrap`（一段一行）、`verify-md-links`（死链）、`doc-typecheck`（围栏 ts 可编译）、`verify-type-equiv`（文档粘贴的类型不漂移）、`verify-doc-budgets`（词数上限）、`verify-translation-pairing`（双语配对）。
- `verify-cordis-catalog`（生成的事件/服务目录新鲜）、`verify-package-invariants`（每包拥有 invariant）、`verify-package-readme-*`（README 的 Model Experience 与 Known Limitations 章节）。
- `gen-module-graph` / `gen-doc-graphs`（模块图与能力图，CI 校验新鲜度）。

## 约定速记（写包前扫一眼）

来自 [`packages/AGENTS.md`](../packages/AGENTS.md) 与根 [`AGENTS.md`](../AGENTS.md#conventions)：

- 服务包**默认导出**服务类；函数插件**具名导出** `name`/`inject`/`Config`/`apply`，无默认导出。
- 可选服务用 `ctx.get(name)`（属性代理 `ctx.<name>` 是拓扑敏感的，严格 `ctx.get` 读全局服务 store）。
- `src/types.ts` 只放类型，无运行时代码；测试在 `tests/` 而非 `src/__tests__/`。
- 瀑布监听器必须 `next()`；注册返回 disposer；可扩展联合 switch 用 `default`。
- 每个包拥有 `./invariant`（注册 manifest 名 + 检查事件/数据关系，或给出包特定的「无运行时不变式」理由）。
- 注册贡献证明 dispose（HMR 安全测试）。
- 文件以**恰好一个**换行结尾；`git diff --cached --check` 门禁。
- 定义文档前，先问钻术语表：不用隐喻，写「响应字段」「JSON 校验」「ESM 导出」而非「响应形状」「验证边界」「模块形状」。

## 一句话实践

**机器可检查的不变量 > 写出来的规范**：把契约写成门禁（events matrix 由 Program 解析、类型文档 `type-equiv` 校验漂移、每文件 100% 覆盖），并「证明每个被改动的接受路径都拒绝一个非法用例」。

下一章回到结业：给出一条源码阅读顺序 + 可动手的练习清单。