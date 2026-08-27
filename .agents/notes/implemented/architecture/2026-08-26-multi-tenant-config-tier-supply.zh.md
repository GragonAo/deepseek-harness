# Agent Note：多租户四层配置供应，带按用户运行期覆盖

状态：implemented

[English](2026-08-26-multi-tenant-config-tier-supply.md) | 中文

## 问题

多租户载体已经按 `(租户, 用户)` 隔离了文件、记忆与容器，并按层目录供应了 skill 与工具，但配置仍是扁平的。一个设置命名空间从 schema 默认值、注册插件的组合 `base`、以及按 `(租户, 用户)` 的 PostgreSQL 文档解析，组合基座与运行期文档之间没有运营人员可读的配置层，也没有任何东西能让案件或平台在不改 patch 文件的前提下在磁盘上钉一个值。四层必须这样分层：同名值近层胜出、异名键并集——会话 > 案件 > 用户全局 > 系统——而运行期用户设置作为最终（最高）覆盖留在 PostgreSQL 按 `(租户, 用户)`（[2026-08-04](2026-08-04-configuration-source-ownership.md) 确定的顺序：用户设置高于组合）。

## 决策

增加一个四根配置载体并在设置 Service Definition 内部读取，位于运行期文档之下一层。

- **`@deepseek-ai/dsh-settings-tier`** 以无状态方式注册可选的 `ctx.settingsTiers` 服务，镜像 `ctx.skillTiers`/`ctx.toolTiers`。`roots()` 读取 ambient 权限并按近层优先返回配置目录：会话（rank 20）`<sessionCwd>/config`、案件（rank 30）`<tenant.workspaceRoot>/shared/config`、用户全局（rank 40）`<usersRoot>/<sub>/config`、系统（rank 50）`$DSH_HOME/system/config`（`systemConfigDir` 配置）。每个根都是 `trustedHost: true`，即租户容器外的宿主机路径。`merged(ns)` 读取 `<root>/<ns>.yaml`、`<root>/<ns>.yml`，再 `<root>/<ns>.json`（ENOENT → 不存在），把每个文件解析成普通对象，并按 系统→用户全局→案件→会话 深合并，于是更近的一层按 key 胜出、异名键取并集。
- **`@deepseek-ai/dsh-settings`** 导出 `SESSION_CONFIG_RANK` `20`、`CASE_CONFIG_RANK` `30`、`USER_GLOBAL_CONFIG_RANK` `40`、`SYSTEM_CONFIG_RANK` `50`，`SettingsTierKind`/`SettingsTierRoot`/`SettingsTierProvider` 类型，以及 `settingsTiers?` 的 Context 扩展，镜像工具/skill 的 rank 表面。`SettingsProvider.resolve` 与 `mergeLayers` 被导出以便载体共享完全相同的合并语义；`resolve` 现在按 `schema(mergeLayers(mergeLayers(base, tier(ns)), section))` 分层——schema 默认值、组合 `base`、合并后的层文档、按 `(租户, 用户)` 的运行期文档，后者始终最高。`tier(ns)` 读取 `this.ctx.get('settingsTiers')?.merged(ns)`，每个提供方都走同一路径。
- **在会话拥有自己的 cwd 之前，会话层坍缩到租户工作区根**：`ambientSessionCwd` 读取发起 agent 的 `session.header.cwd` 并回退到 `tenant.workspaceRoot`，因为当前同一租户的所有会话共享该根。
- **层文件在解析时点重读，而非每次读取都重读**：注册、`(租户, 用户)` 作用域激活与文档发布会重读文件，因此磁盘上的改动在下一个此类时点生效——与工具清单加载器同一节奏。畸形的层文件在注册时大声失败；之后磁盘上的编辑经现有提交守卫保持该命名空间上一次的好值。

## 舍弃的备选

- **把合并后的层文档折进 PostgreSQL 文档内部。** 舍弃：那会把运营管理的磁盘源压平进一个用户可写文档，于是案件或平台无法在不被模型改写回去的前提下改配置，凭据也会被引诱进文档而非被拒绝。
- **只在 settings-file 提供方里读层文件。** 舍弃：按 `(租户, 用户)` 的运行期文档在 `settings-postgres` 而非文件里；层合并属于 Service Definition，这样每个提供方（file、postgres、memory）都按同样方式分层。
- **把会话层做成 `shared/config` 下的目录。** 舍弃：案件共享目录下的会话层无法在不把会话 id 塞进租户内每个会话共享的路径的前提下按会话变化；会话 cwd 是唯一持久的按会话磁盘锚点，今天就坍缩到工作区根，已在下方记录。

## 后果

**换来：** 一个设置命名空间现在从 schema 默认值、组合基座、系统配置目录、用户全局目录、案件共享目录与会话目录解析，然后是 PostgreSQL 按 `(租户, 用户)` 文档（最高）；同名值按近层胜出分层而异名键取并集，且单个 `<ns>.yaml` 文件可以覆盖一个 key 而不替换该命名空间的其它 key。skill/工具层按名称合并整个目录条目，配置则按 key 合并进那一个命名空间文件。

**代价与暂缓工作：** 在会话拥有自己的 cwd 之前，会话层坍缩到工作区根；注册、作用域激活与发布时的同步宿主机读取对小命名空间集合足够，按 `(scope, ns, mtime)` 的暖缓存暂缓。

### 验证

`tsc -b tsconfig.host.json`（完整宿主面）通过。`dsh-settings` 新增 `tier.spec.ts`（默认值 < base < 层 < 文档，以及 `replace(ns, {})` 后层重新继承）；`settings-tier` 交付七个单元测试覆盖根解析、作用域省略、深合并、空与标量拒绝，另有一个走真实目录的真实组合集成测试，证明 文档 > 会话 > 案件 > 用户全局 > 系统 > base。`bundle/multi-tenant` 断言 `settings-tier` 挂载及其 `DSH_USERS_ROOT` 配置钉值。`verify-cordis-config`、`verify-package-invariants`、`verify-package-readme-model-experience`、`verify-package-readme-limitations`、`verify-export-jsdoc`、`verify-translation-pairing` 全部通过。在 `192.168.138.130` 上，组合后的 `--dump-config` 显示 `settings-tier` 行，配置 RPC 闭环 6/6 通过（会话 > 案件 > 用户全局 > 系统 覆盖 base；PostgreSQL 文档最高；user-1@beta 解析用户全局；user-2@acme 在没有用户全局层时解析会话），12/12 会话隔离回归保持绿色。