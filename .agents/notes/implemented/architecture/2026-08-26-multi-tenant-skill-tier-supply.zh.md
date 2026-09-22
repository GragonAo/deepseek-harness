# Agent Note: 多租户 skill 分层供应

Status: implemented

[English](2026-08-26-multi-tenant-skill-tier-supply.md) | 中文

## 问题

多租户载体（[2026-08-24](2026-08-24-multi-tenant-slice.md)）把每个 (租户, 用户) 作用域的文件、记忆与容器都隔离开来，但 skill 仍通过单用户的 `dsh-skill-filesystem` 提供方解析，其根 —— 项目、自定义、用户 DSH、用户 agents、bundled —— 都绑定到同一个 harness home，没有租户或主体的概念。三层供应要求同名 skill 按「近层胜出」（案件共享 `/shared` 胜过用户全局 `/global`，再胜过系统层）、异名并集，并要求案件层与用户全局层目录从该请求自身的 (租户, 用户) 权威解析，而不是任何宿主全局路径。

## 决策

新增一个环境层级服务，让文件系统提供方在每次发现时读取，并在每次调用时从权威作用域解析其三个根。

- **`@deepseek-ai/dsh-skill`** 新增 `CASE_SKILL_RANK` `30`、`USER_GLOBAL_SKILL_RANK` `40`、`SYSTEM_SKILL_RANK` `50`（低于所有 `100`+ 的静态提供方 rank）、`SkillTierKind`/`SkillTierRoot`/`SkillTierProvider` 类型，以及可选的 `ctx.skillTiers` Context 声明合并。
- **`@deepseek-ai/dsh-skill-filesystem`** 在其静态根之前追加 `this.ctx.get('skillTiers')?.roots() ?? []`。可选服务必须经 `ctx.get` 读取（可选服务惯用法的严格存储读取），而非拓扑敏感的属性代理；不存在时跳过。已发现候选的 `LocalLocator` 携带其所属根的 `trustedHost`，`get` 以 `locator.trustedHost` 重读文件；若改为从 `candidate.source` 推断该标志，则只覆盖 bundled 根，于是层级 skill 能被列出却无法加载。
- **`@deepseek-ai/dsh-skill-tier`**（新包）把 `ctx.skillTiers` 注册为无状态的 `Service`：`roots()` 读取 `currentTenant()`/`currentUser()`，返回案件根 `<tenant.workspaceRoot>/shared/skills`、用户全局根 `<usersRoot>/<sub>/skills` 与系统根（`systemSkillsDir`，默认 `$DSH_HOME/system/skills`），全部 `trustedHost: true`，因为它们是租户容器外的宿主机路径。
- **bundle** —— `multi-tenant/cordis.patch.yml` 挂载 `skill-tier`（`dsh-skill-tier`），其 `usersRoot` 取自 `DSH_USERS_ROOT`，与消费同一值的 `container-runtime` 并排。

环境读取无需改缓存键即正确：skill 注册表的 collect 缓存以 `{ cwd, scopeChain, revision }` 为键，而每个多租户查找都传入会话唯一的 scope 键，所以逐请求的层级根会落入独立的会话缓存条目。

## 被否掉的备选

- **把三个目录作为静态 `customSkillDirs` 写进 bundle** —— 固定的启动路径无法按 (租户, 用户) 变化，于是某租户的案件 skill 会泄漏进其它每一个请求。选用：环境服务。
- **给 `skill-filesystem` 配置加 `usersRoot`** —— 把租户权威折进单用户提供方，仍无法覆盖系统层与案件共享路径。选用：独立的载体包。
- **启动时解析层级根** —— 启动快照会漏掉作用域或启动后才创建的目录；每次 `roots()` 调用的无状态读取才使层级跟随请求。

## 后果

**所得：** case > user-global > system 优先级（在文件系统提供方的单层内以较低 rank 胜出）加异名并集；层级目录从请求自身的权威解析；三个根都经 `trustedHost` 绕过容器作用域的文件服务，在发现时如此，在加载已发现 skill 时同样如此。单用户安装从不注册 `ctx.skillTiers`，行为不变。

**成本与暂缓工作：** 这只是 skill 层；四层配置供应是仍待交付的剩余切片（三层工具供应已于 [2026-08-26](2026-08-26-multi-tenant-tool-manifest-loader.md) 交付）。系统层是约定只读而非强制 —— 创建并保持该目录只读由部署方负责。已部署的 `192.168.138.130` 上经真实 Loader + Docker + Postgres 的闭环回合仍是服务器步骤。

### 验证

对 skill、skill-filesystem、skill-tier 与 bundle 包执行 `tsc -b` 通过。四个 `skill-tier` 单元测试覆盖根解析、作用域内与外层级、以及系统根的 `$DSH_HOME` 默认值。两个 `skill-filesystem` 集成测试启动注册表 + 固定层级服务：一个断言同名 skill 的 `case > user-global > system` 与异名的并集，另一个注册一个视野不含层级根的文件系统服务，断言该层级 skill 仍能加载其正文 —— 只要加载改为从 `candidate.source` 推断宿主信任，该断言即失败。`bundle/multi-tenant` 测试断言 `skill-tier` 挂载与其 `DSH_USERS_ROOT` 钉值。`verify-cordis-config`、`verify-export-jsdoc`、`verify-package-invariants`、`verify-translation-pairing` 与 README 的 Model-Experience/limitations 门禁均通过。