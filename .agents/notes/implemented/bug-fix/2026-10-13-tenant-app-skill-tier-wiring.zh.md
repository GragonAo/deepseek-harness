# Agent Note: Tenant app wires the three skill tiers

Status: implemented

[English](2026-10-13-tenant-app-skill-tier-wiring.md) | 中文

## Problem

部署在宿主上的租户会话看不到系统层的任何技能——包括这个案件流程本来就要驱动的报告模板技能。三层技能的载体（[2026-08-26](2026-08-26-multi-tenant-skill-tier-supply.md)）通过 `ctx.skillTiers` 发布三个层根，而 `@deepseek-ai/dsh-skill-filesystem` 是唯一扫描它们的读取者；租户应用组合的是自己的 spine，而不是加载 `multi-tenant` profile，所以注册该读取者的那一行就是这条接线唯一可能断掉的地方。

它同时断了三处。`skill-filesystem` 行带着 `disabled:`，于是三个层根的唯一扫描者根本没注册，所有层技能都不可见。`skill-tier` 行没有给 `usersRoot`，用户全局层整层消失。它也没给 `systemSkillsDir`，该根于是回落到 `$DSH_HOME/system/skills`——即租户宿主上的 `~/.dsh/system/skills`，那里并不存在这棵树——而部署的系统层实际位于 `<sandbox.systemRoot>/skills`。

这个失败在构造上就是静默的：缺一个根表现为一个目录不存在，而不是一个错误，于是注册表只是报出一个更小的目录清单，会话就在没有它本该使用的技能的情况下继续跑下去。

## Decision

租户应用的 spine 注册文件系统读取者，并把部署实际使用的两个宿主路径连同三个层根一起交给它。

- **`skill-filesystem`** 去掉 `disabled:`，带上 `config: () => ({ includeDefaultRoots: false })`。该 provider 自带的项目层与用户层根按宿主的 cwd 与 HOME 解析，而在租户宿主里它们指向与租户无关的目录——会话 cwd 是宿主上不存在的容器路径——所以只扫 `skill-tier` 的三层根。
- **`skill-tier`** 带上 `usersRoot: config.tenants.usersRoot`；当 `sandbox.systemRoot` 已配置时，再带上由 `systemSkillsDir(config)` 助手给出的 `systemSkillsDir: join(sandbox.systemRoot, 'skills')`，该助手在根未配置时返回 `undefined`。此时是**省略**这个键而不是传 `undefined`，这样未配置 `systemRoot` 的部署仍保留 `skill-tier` 自己的 `$DSH_HOME` 缺省，而不会被一个凭空拼出的路径覆盖。
- **`<sandbox.systemRoot>/skills`** 就是两个容器后端都挂成沙箱 system 技能层的那棵树，因此宿主侧扫描与沙箱内挂载指的是同一个目录。

## Alternatives considered

- **重新启用 `skill-filesystem` 并用它自带的根** ——项目根按会话 cwd 解析（一个在宿主上没有对应物的容器路径），用户根按宿主 HOME 解析，于是发现过程会去扫属于 harness 用户而不是租户的目录，还可能把一个租户的技能露给另一个租户。选择：`includeDefaultRoots: false` 加上三个权威根。
- **把三个层根钉在部署的 `cordis.patch.yml` 里** ——租户应用不加载那个 profile；它的组合点是 spine，profile 里的条目根本到不了这条路径。选择：在 spine 里配置这些行。
- **让 `skill-tier` 自己给 `usersRoot` 和 `systemSkillsDir` 定缺省** ——`skill-tier` 无从知道某个部署的 `usersRoot`，而它的 `$DSH_HOME` 缺省对单用户安装是正确的；一个会把错误的部署路径藏起来的缺省，正是本笔记要修的那种静默失败。选择：在组合点强制供给。
- **层根缺失时直接报错** ——缺失是合法的（一个部署可以没有案件共享技能），在这里报错会否掉有效的配置。选择：根层面保持静默，交由层优先级规则判定。

## Consequences

**换来：** 租户会话能看到部署的系统层技能——部署宿主上的案件流程加载了系统层的报告模板技能并执行了它的脚本——以及按既定优先级解析的案件共享层与用户全局层，三层都按请求自身的 (tenant, user) 权威解析。单用户安装不受影响：它们从不注册 `ctx.skillTiers`，也不组合这个 spine。

**代价与未完事项：** 租户应用现在在两个地方声明系统根，且两处必须一致——这里的 `sandbox.systemRoot` 与容器后端挂成沙箱 system 层的那一份；改了其一而未改其二的部署，会得到一个列出了沙箱根本读不到的技能的清单。系统层仍按约定只读，而非强制只读。

### Verification

`tsc -b packages/tenant/tenant-app/tsconfig.json` 通过；`npx tsx scripts/run-oxlint.ts packages/tenant/tenant-app` 无新增发现（4 个既有错误、0 个警告）。`packages/tenant/tenant-app/tests/app.spec.ts` 覆盖这几行：`skill-filesystem` 行存在且未被禁用并带 `includeDefaultRoots: false`；`skill-tier` 行在 `sandbox.systemRoot` 已设置时带 `usersRoot` 与 `systemSkillsDir`，未设置时省略该键；31 个测试通过。`192.168.138.130` 上的部署闭环是端到端证据：改动前该流程触达不到任何系统层技能，改动后它读了技能正文并执行了技能脚本。

## Related

三层机制本身——优先级、rank、发现与加载两处的 `trustedHost`——见 [2026-08-26](2026-08-26-multi-tenant-skill-tier-supply.md)，此处未改动；本笔记只记录租户应用对这三个根的供给。同三个根在沙箱一侧是 [2026-10-08](2026-10-08-sandbox-skill-tiers-are-mounts.md)，它把 `<systemRoot>/skills` 挂成 `/opt/data/skills/system`——此处的宿主侧扫描必须指认同一棵树，这正是 Consequences 一节记下的耦合。让未供给的 `systemSkillsDir` 落到树外的那个 `$DSH_HOME` 缺省见 [2026-07-24](2026-07-24-single-harness-home-resolver.md)。
