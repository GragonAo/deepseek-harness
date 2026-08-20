# DeepSeek Harness 学习手册

> 从 0 到精通：框架设计思想、架构、源码实现、扩展点与工程实践。

这套手册是给想彻底搞懂 [DeepSeek Harness](../README.md) 的读者准备的一条循序渐进的学习路径。它不替代官方文档，而是把它们组织成一条「新手 → 会用 → 理解 → 深入源码 → 精通扩展」的路线，并在关键处指出**为什么要这样设计**（设计思想）与**源码在哪里落地**（实现）。

## 这个项目一句话

DeepSeek Harness 是一个建立在 vendored [Cordis](../docs/cordis-primer.md) 之上的**插件式 agent 运行骨架（harness）**。它有一条铁律：**一切都是插件**。模型适配器、工具注册表、会话日志、甚至 agent 循环本身，全部是插件，全部可以从 `cordis.yml` 配置里替换。因此它没有一块「特权核心」需要你去 hack——你通过「在别的插件旁边再挂一个插件」来扩展它。

## 目录与阅读顺序

按顺序读即可。每章开头的括号标注了该章对应的能力阶段。

| # | 章节 | 阶段 | 一句话内容 |
|---|---|---|---|
| 1 | [全景与心智模型](01-overview.md) | 0 · 新手 | 它是什么、解决什么问题、四张心智地图 |
| 2 | [Cordis 地基](02-cordis-foundation.md) | 0 → 会用 | 插件、服务、上下文、事件、可逆副作用五个核心概念 |
| 3 | [架构全景](03-architecture.md) | 会用 → 理解 | 组合（profile/bundle）、六核心包、三层事件、轮次/步骤流 |
| 4 | [设计思想](04-design-philosophy.md) | 理解 | 15 条核心设计原则，每条都有出处与落地位置 |
| 5 | [主干六包源码精读](05-core-spine.md) | 深入源码 | session / system-prompt / tools / agent / agent-loop / scope |
| 6 | [一次 turn 的完整旅程](06-turn-flow.md) | 深入源码 | inbox → pre-step → deriveMessages → 请求 → 流式 → 工具 → 收尾 |
| 7 | [工具执行流水线](07-tool-pipeline.md) | 深入源码 | pre-execute → 守卫 → execute → post-execute → result |
| 8 | [事件系统与类型模式](08-events-and-types.md) | 深入源码 | 三层事件、声明合并、`Map → union`、品牌化 ID |
| 9 | [能力 seam 三件套](09-capability-seams.md) | 精通 | Service Definition / Provider / Consumer，以 shell 为范例 |
| 10 | [单一执行世界](10-execution-world.md) | 精通 | subprocess / sandbox / fs 如何共享一个执行世界 |
| 11 | [LLM 与远程网关](11-llm-typert-api.md) | 精通 | LLM seam、Typert 类型图、API 网关、SDK/ACP |
| 12 | [会话数据面](12-session-data-plane.md) | 精通 | 持久化 / 投影 / 查询 / 存储 / 遥测 / title / spill |
| 13 | [能力全景目录](13-capabilities-catalog.md) | 精通 | skill/web/subagent/workflow/jobs/compaction/guard/… 逐个速览 |
| 14 | [扩展实战](14-extending-dsh.md) | 精通 | 加模型、加工具、加 seam、加 UI、加持久状态 |
| 15 | [工程规范与测试](15-engineering-practices.md) | 精通 | 类型模式、防御性模式、分层测试、门禁体系 |
| 16 | [进阶路线与练习](16-learning-path.md) | 自检 | 源码阅读顺序、动手练习清单、深挖索引 |

## 配套资源（官方）

- 架构入口：[`docs/architecture.md`](../docs/architecture.md)（改 `packages/` 前必读）
- 术语表：[`docs/glossary.md`](../docs/glossary.md)（每个概念一个规范术语）
- Cordis 教程：[`docs/cordis-tutorial/index.md`](../docs/cordis-tutorial/index.md)（动手式入门）
- 子系统参考：[`docs/subsystems/README.md`](../docs/subsystems/README.md)（每个子系统一页，含生成的 Cordis API）
- 扩展手册：[`docs/cookbook/extension-cookbook.md`](../docs/cookbook/extension-cookbook.md)
- 设计决策记录：[`.agents/notes/`](../.agents/notes/README.md)（「为什么这样做」的一手记录）

## 怎么用这套手册

- **想快速上手跑起来**：读第 1、2、3 章，然后直接看 [AGENTS.md](../AGENTS.md) 的 `Commands` 一节跑 `pnpm dsh --profile headless "任务"`。
- **想做贡献、改代码**：把第 3、4、8、15 章读透——它们是「读 `packages/` 之前」的准入门槛。
- **想彻底精通、自如扩展**：按顺序读完，配合第 16 章的练习在真实源码里验证每一条结论。

每章正文里指向源码的路径都用 `packages/<group>/<pkg>/src/...` 这样的内联代码标出，方便你在编辑器里直接跳转。官方文档的交叉引用用相对链接给出，遇到只给链接的地方，说明那个主题在官方文档里已有权威表述，手册只做导读而非重复。