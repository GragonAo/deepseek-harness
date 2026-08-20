# 第 1 章 · 全景与心智模型

> 阶段：0 · 新手。读完你能回答：DeepSeek Harness 是什么、解决什么问题、它和「一个调用 LLM 的脚本」的区别在哪。

## 它是什么

DeepSeek Harness（简称 dsh）是一个**可组合、可扩展的 agent 运行骨架**。给一个模型接入点，加上工具（跑 shell、读写文件、搜索网页、委派子智能体……）与持久会话，dsh 就能驱动一个 agent 循环：模型提出要做的事 → 框架执行工具 → 把结果喂回模型 → 循环直到任务完成。

它不是某个单一应用的「框架内核」，而是一层**运行时**：它定义了 agent 如何被创建、如何接收输入、如何组装提示词、如何执行工具、如何把每一步写进日志，然后把所有这些环节开放成可替换的扩展点。

## 它解决的四个问题

一图看透一个 agent 应用需要解决的核心问题，以及 dsh 的答案：

| 问题 | 朴素做法（一个脚本） | dsh 的答案 |
|---|---|---|
| 模型调用 | 硬编码 `fetch` 某个 API | `ctx.llm` 适配器 seam，多 provider 可切换 |
| 能力（工具） | 一堆写死的函数 | `ctx.tools` 注册表 + 守卫执行流水线 |
| 状态与历史 | 变量里塞一个消息数组 | 仅追加的 `SessionEvent` 日志，历史从日志**派生** |
| 扩展与组合 | 改源码、复制粘贴 | Cordis 插件树：挂一个插件即可，卸载即回收 |

## 铁律：一切都是插件

这是进入 dsh 的第一心智模型。架构文档开宗明义（[`docs/architecture.md`](../docs/architecture.md#cordis)）：

> 没有特权核心可修补：你在别的插件旁边挂一个插件来扩展 dsh，而注册是可逆的副作用，插件卸载即撤销。

连「agent 循环本身」都是一个插件（`dsh-agent-loop`），它只是实现了公开的 `Agent` 约定。这意味着你能在不改框架的前提下替换循环、替换模型、替换文件系统实现。

## 四张心智地图

在深入之前，先在脑子里放四张图。全书就是在展开它们。

### 地图 A：三层服务

`ctx` 是服务的容器。服务按角色分三层（详见[第 3 章](03-architecture.md)与[第 9 章](09-capability-seams.md)）：

1. **主干（core spine）**：`ctx.sessions`、`ctx.systemPrompt`、`ctx.tools`、`ctx.agents`、`ctx.agentLoop`——每个组合都会启动。
2. **能力 seam（seam）**：`ctx.llm`、`ctx.shell`、`ctx.fs`、`ctx.web`……可替换的三件套（Service Definition / Provider / Consumer）。
3. **组合点（composition）**：profile / bundle，把插件按层叠成一棵树。

### 地图 B：三种事件

事件是扩展点，选对事件域是大多数改动的第一步（[`docs/architecture.md`](../docs/architecture.md#events)）：

- **会话事件**（`session/event` 携带，持久）：需要重放才能活下来的事实。
- **Agent 事件**（`agent/*`，实时）：观察或拦截在途工作。
- **能力事件**（`fs/*`、`tools/*`、`telemetry/*`）：给某个 seam 挂政策与适配器，不导入循环。

### 地图 C：轮次 / 步骤

- **step（步骤）** = 一次模型请求 + 它触发的工具调用。
- **turn（轮次）** = 零到多个 step：从宣告第一个输入被认领开始，到「什么都不再欠着」结束。

详见 [`docs/architecture.md`](../docs/architecture.md#turn-flow) 与[第 6 章](06-turn-flow.md)。

### 地图 D：模型可见 ⟺ 已入日志

模型的每一次请求都必须能**从会话日志重建**。一条铁律：「模型可见 ⟺ 已入日志」（model-visible ⟺ logged）。历史上不是从日志派生的；日志是唯一的真源（[第 3 章](03-architecture.md)、[第 8 章](08-events-and-types.md)）。

## 仓库布局一分钟

```
vendor/       vendored 的 Cordis 源码（改名映射见 docs/rescope.md）
packages/     @deepseek-ai/dsh-<pkg>，按 group 分目录（packages/<group>/<pkg>）
python/       Python SDK 与捆绑 runtime
native/       node-addon-landlock-run（进程沙箱 Landlock 后端）
examples/     可运行的 cordis.yml 叶子（学习与快照测试用）
docs/         架构、子系统、cookbook、术语表
scripts/      仓库门禁与生成器
website/      VitePress 投影部分双语 docs
```

package 分组与每个包的职责见 [`packages/README.md`](../packages/README.md)，共有几十个能力包；本书第 5、9～13 章逐个讲重点。

## 一句话总结

把 dsh 想成：**一个用插件拼出来的 agent 操作系统**——内核（Cordis）只提供「挂载插件、按依赖启动、类型化事件、可逆回收」这几个原语，产品的一切（模型、工具、循环、日志、UI）都是插件，因此每一个部分都能被配置替换、被事件拦截、被 provider 换装。

接下来读[第 2 章 · Cordis 地基](02-cordis-foundation.md)，先把那五个原语吃透。