# Agent Note: 技能写入的层由请求决定，而不是由载荷决定

Status: implemented

[English](2026-10-23-skill-tier-writes-from-request-scope.md) | 中文

> 一个技能包落在哪个目录，本身就是它的地址；而那个目录是调用者身份的属性。让调用方在载荷里点名层的管理面，就是让某个租户能写整个部署的系统技能。

## Problem

技能分三层——`case`、`user-global`、`system`——每一层的根由 `@deepseek-ai/dsh-skill-tier` 从请求自身的 scope 解析出来：案件工作区、`usersRoot` 下这个用户自己的目录、或部署的系统目录。在此之前，业务面只有一条带层的列举方法（`skill.list`，一个会话**可调用**的合并目录），所以想增删技能的人只能拿到一个宿主路径。真正存在的管理流程在 harness 之外——业务层的调度器桥——它调用的是 harness 已不再运行的服务。

因此 harness 需要一个技能包的写面。两个要求方向相反：案件成员必须能装技能（否则这个能力没有意义），而案件成员不能写一个"之后所有案件都在跑"的技能。决定这件事的是写入地址，而地址由"谁在问"推导出来。

还有第二个缺口。技能包是人手工准备出来的归档，所以它的错法都很普通：`SKILL.md` 埋在两层目录下、frontmatter 写坏了、软链接指向 `/etc`、归档里塞了半个 GB。旧流程给什么装什么，于是一个坏归档变成一份坏掉的工具清单，直到对话中途才被发现。

## Decision

业务面三条方法——`skill.install`、`skill.remove`、`skill.installed`——并且任何一条都没有 tier 字段。

- `skill.install` 的载荷是 `{zip, replace?}`，`skill.remove` 是 `{name}`，`skill.installed` 为空。方法用固定的层 `user-global` 调 `ctx.skillInstall`，目录由请求自身的租户与用户 scope 经 `runWithTenant`/`runWithUser` 解析——调用者的身份**就是**地址。
- tier 字段等于"点名一个调用者不该够到的目录"，所以它不存在。系统层只由管理面写（租户管理 HTTP 面的 `skills.list`、`skills.upload`、`skills.remove`），它用管理令牌鉴权，而不是用租户请求。
- 两个面共用一套校验 seam：`@deepseek-ai/dsh-skill-install`。只有同时满足以下条件才收一个包：归档根上恰好一个 `SKILL.md`，或它被唯一一层包装目录包住；没有任何条目解析后逃出目标目录（绝对路径、`..` 段、软链接）；解压前不超过 16 MiB、解压后不超过 64 MiB、条目数不超过 2048；frontmatter 能加载成一份文档。不合格的包整个拒收：不留半个目录。
- 安装与删除都以一次 rename 换掉技能目录，随后调 `ctx.skills.refresh()`。`install` 返回 `{name, directory, replaced, files, visible}`；`visible` 表示刷新之后它是否已经进了可调用清单——一个语法上没问题的包仍可能在这个部署里加载不出来，调用方就是从这里知道的。
- `skill.installed` 返回带层的管理清单——`{directory, entries[{entry, name?, description?, loadable, issues[]}]}`——**包含**加载不出来的条目，每条带 `{code, message, line?}` 文档问题。`skill.list` 保留它自己的问题：会话可调用的合并目录。
- 业务面上所有拒收归成一个错误 `skill-rejected`，携带 `details.reason`（seam 自己的码）与 `details.issues`。HTTP 载体据此推出的状态码按 seam 码分组：`skill-exists` 与 `skill-ambiguous` → 409，`skill-absent` → 404，`bundle-invalid` 与 `bundle-unsafe-entry` → 400，`bundle-too-large` → 413，`tier-unavailable` → 503。管理面直接返回这些码，因为它转给 seam 时中间没有业务信封。

## Alternatives considered

- **把 `tier` 放进载荷，再按调用者校验。** 否决：这样判定就活在方法旁边而不是方法里，每个后来的调用方都要重复一遍。字段的缺席本身就是判定。
- **两个调用方共用一族方法，靠令牌 scope 选管理路径。** 否决：由租户推导出的 scope 就得回答"系统层请求意味着什么"，而那正是两个面已经分开的东西。
- **线上收 multipart 的包。** 否决：业务载体是每条方法共用的一个 JSON 信封（`client-request`），为这两条调用多出一种请求体编码不值。手里有文件的业务层自己去编码。
- **拿 `skill.list` 当管理清单。** 否决：合并目录回答的是"会话能调哪些"，按构造就会藏起加载失败的条目。管理界面要的恰好是相反的答案。
- **在业务层先校验包再调 seam。** 否决：管理面也调 seam，规则就有了两份，然后各自漂移。
- **把 seam 的每个码都镜像到业务面**（`skill-exists`、`skill-absent`……）。否决：那些码说的是 seam 的条件，按它们分支的客户端就和安装包绑死了。一个线上码加 `details.reason` 让业务面闭在自己的词表里，同时把原因留在外面看得见。
- **装完不查目录就报成功。** 否决：一个包装得进去但仍然加载不出来（同名已被别的层占用、frontmatter 要的工具这个部署没有）。没有 `visible`，调用方唯一的证据就是之后再列一次。

## Consequences

- 案件成员能装、列、删自己用户目录里的技能，而任何载荷都够不到案件层、系统层或别人的目录。
- 案件级技能仍不暴露：没有方法写案件的 `skills/` 目录，所以一个案件的技能集合仍是案件所有者磁盘上的责任。
- 系统技能只能经管理面够到，这意味着没挂管理面的部署在运行时改不了它们——此时系统技能是打包决策，不是运行时决策。
- 没挂 `skill-install` 的部署在每次调用时报出这个缺席（`internal: skill installation is absent`），而不是启动即失败，所以没有技能管理的 harness 照旧能跑。
- 被拒的包只花一次请求、一条消息：调用方知道是 `SKILL.md` 的哪一行、哪个归档条目有问题，并且什么都没写进去。
- 现在有两个面、两套错误词表在回答技能写入。同时跟两边说话的业务层——jeecg 桥就是——需要为管理面直接发出的那些 seam 码准备映射；而它那条收 zip 的路径两边是同一段代码。
- 列举面报出加载不出来的条目而不是丢掉它们，所以管理界面必须把 `loadable: false` 连同 issues 画出来，而不能假设每个条目都能用。