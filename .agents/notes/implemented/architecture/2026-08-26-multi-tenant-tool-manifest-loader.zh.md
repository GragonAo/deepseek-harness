# Agent Note：多租户声明式工具供应

Status: implemented

[English](2026-08-26-multi-tenant-tool-manifest-loader.md) | 中文

## 问题

技能层级（[2026-08-26](2026-08-26-multi-tenant-skill-tier-supply.md)）已经交付了案件级 > 用户全局 > 系统级的技能供应，但工具仍然只通过内置注册表和固定的工具包解析：任何租户、用户或案件都无法通过文件新增工具，工具也没有同名就近优先的分层。三层工具需求要求同名工具按最近一层胜出（案件共享 `/shared` 优先于用户全局 `/global`，后者又优先于系统级）、异名取并集；同时由于这些层级是租户编写的，只能接受声明式清单、绝不接受可执行代码，并且凭据不得进入任何挂载目录。

## 决策

先让工具注册表支持 rank，再在其上注册一个环境层级服务和一个纯数据清单加载器。

- **`@deepseek-ai/dsh-tools`** 新增 `CASE_TOOL_RANK` `30`、`USER_GLOBAL_TOOL_RANK` `40`、`SYSTEM_TOOL_RANK` `50`，以及可选的 `ctx.toolTiers` Context 扩展。它的层级改用私有 `ToolEntries`（每个条目有 `id`、按名称维护遮蔽栈），使 `register(definition, rank?)` 按 rank 解析同名——rank 小者胜出，未标 rank 的内置注册优先级最低（`rank ?? +Infinity`），销毁条目时不受顺序影响地恢复被遮蔽者。
- **`@deepseek-ai/dsh-tools-tier`** 把 `ctx.toolTiers` 注册为无状态的 `Service`：`roots()` 读取 `currentTenant()`/`currentUser()`，返回案件级根 `<tenant.workspaceRoot>/shared/tools`、用户全局根 `<usersRoot>/<sub>/tools` 和系统级根（默认 `$DSH_HOME/system/tools`），全部 `trustedHost: true`。
- **`@deepseek-ai/dsh-tools-manifest`**（加载器）注册一个全局 `agent/created` 监听器，读取 `ctx.get('toolTiers')?.roots()`，按系统级 → 用户全局 → 案件级排序，把每份清单按其根目录的 rank 注册进 `agent.ctx.tools`。agent 作用域销毁时相应地解除注册。
- **清单是纯数据**：kebab-case 的 `name`、一份 `description`、扁平字符串 `parameters`（`type: string`，可选 `description`/`required`）、固定 `executor`（`command`、带 `$field` 占位符的 `args` 模板、可选 `cwd`/`env`）以及可选 `timeoutMs`。`defineTool` 提供参数校验与 schema 投影，因此没有任何参数或执行器逃出这个经过校验的面。
- **执行始终留在租户容器内**：加载器通过 `ctx.subprocess`（在多租户 carrier 里就是容器 provider）启动，带界定的 stdout/stderr 收集、`graceMs` 终止和 `defaultCwd`（配置项 `defaultCwd`，bundle 固定为 `/workspace`）。这是相对“在宿主机上运行清单命令”的有意偏离：租户编写的案件级清单不得逃逸容器隔离。

## 已考虑的其他方案

- **在宿主机上启动清单命令** —— 执行器最简单，但案件级清单（租户编写）就会在宿主机上与其他租户并肩运行。已否决：租户容器才是隔离边界。
- **`prepare()` 预热缓存** —— 异步钩子预解析层级目录比每次请求现读更省，但会引入 agent-http 耦合与预热竞态。延后：对少量清单，按 `agent/created` 同步读取即可接受。
- **绕过 `defineTool` 的裸 JSON-Schema 参数** —— 表达力更强，但会丢掉参数校验和注册表的 schema 投影。已否决：通过 `defineTool` 使用扁平字符串 `ValueSchemaSpec` 参数，保持唯一一条经过校验的路径。

## 后果

**获得：** 案件级 > 用户全局 > 系统级的工具优先级加上异名并集；层级目录从请求自身权限解析；只需放下一份 YAML 文件即可新增工具，无代码、无凭据面；清单命令在租户容器内执行。

**代价与后续工作：** 参数仅限扁平字符串标量（`$field` argv 替换尚不能表达更丰富的形式）；每次创建 agent 都会同步重新读取清单；四层配置供应，以及部署到 `192.168.138.130` 的闭环验证仍是接下来的切片。

### 验证

`tsc -b tsconfig.host.json`（完整 host face）通过。`dsh-tools` 中的 rank 测试证明带 rank 的层级注册会遮蔽同名的未标 rank 内置工具，并在销毁时恢复。四个 `tools-manifest` 测试覆盖清单解析、`案件级 > 用户全局 > 系统级` 优先级与并集，以及一次进程内执行器调用；`agent/created` 钩子通过真实启动（session、tools、subprocess-local、agent registry、tier provider）得到验证。`bundle/multi-tenant` 断言 `tools-tier` 与 `tools-manifest` 的挂载及其配置固定。`verify-cordis-config`、`verify-package-invariants`、`gen-tool-catalog`、`verify-translation-pairing` 以及 README 的 Model-Experience/limitations 门禁全部通过。