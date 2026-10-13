# @deepseek-ai/dsh-skill-install

技能包上传服务（`ctx.skillInstall`）：把在线传来的技能 zip 装进某个环境技能层，替换或删除已装技能，并在每次变更后刷新进程级技能目录缓存。它注入 `skills`（[`@deepseek-ai/dsh-skill`](../skill/README.md)），可写的目录由环境技能层提供者 `ctx.skillTiers`（[`@deepseek-ai/dsh-skill-tier`](../../tenant/skill-tier/README.md)）在调用时解析，因此本包不持有任何路径配置。

## 为什么需要它

`ctx.skills` 按 `(cwd, 作用域链, revision)` 缓存整份目录，`revision` 只在提供者注册、注销或显式失效时递增。往技能层目录里直接放文件不会触发这条路径：宿主上的 inotify 只盯着启动时扫到的那些 inode，新目录不在其中，于是运行中的进程会一直读那份旧目录，新技能直到重启才出现。本包把「变更」与「刷新」绑在一次调用里：写完之后调 `ctx.skills.refresh()`（`@deepseek-ai/dsh-skill` 的独立方法），再回读目录确认名字真的出现，把结果作为 `visible` 返回。

## 方法

| 方法 | 请求 | 返回值 | 作用 |
|---|---|---|---|
| `install` | `{ tier, bundle, replace?, signal? }` | `{ tier, name, directory, replaced, files, visible }` | 校验整个包，暂存 + 一次 `rename` 换入；`replace: true` 才允许覆盖同名技能。 |
| `remove` | `{ tier, name, signal? }` | `{ tier, name, directory, visible }` | 按目录名或 frontmatter 名定位并删除，随后刷新。 |
| `list` | `{ tier, signal? }` | `{ tier, directory, entries }` | 列出该层目录，逐条给出是否可加载与带码原因（含人工放进去的文件）。 |

`tier` 是 `SkillTierKind`：`case`、`user-global`、`system`。安装目标是 `<层目录>/<frontmatter 名>/`，与技能发现规则一致：只有 frontmatter 的 `name` 决定注册名，目录名不参与。

包内必须恰好有一个根 `SKILL.md`；`<某个目录>/SKILL.md` 这种整体打包的布局会先剥掉那一层包装目录。文档按 [`@deepseek-ai/dsh-skill` 的 `readSkillDocument`](../skill/README.md) 校验，与运行时跳过技能用的是同一套判据。

## 失败

每个拒绝都是一个 `SkillInstallError`，带 `code` 与可选 `details`：

| `code` | 触发条件 |
|---|---|
| `tier-unavailable` | 没有 `ctx.skillTiers`，或该作用域没有发布要写的层（`details.kinds` 列出实际发布的层）。 |
| `bundle-invalid` | 不是可读的 zip、条目重复、没有根 `SKILL.md`、或有多个包内 `SKILL.md`。 |
| `bundle-unsafe-entry` | 条目是绝对路径、盘符路径、含空段或 `..`，或解出的路径逃出技能目录（`details.entry`）。 |
| `bundle-too-large` | 包体超过 `maxBundleBytes`，条目数超过 2048，或解压总量超过 `maxExpandedBytes`。 |
| `skill-invalid` | `SKILL.md` 无法成为可加载技能：`details.issues` 逐条给出 `code` 与 `line`。 |
| `skill-exists` | 同名技能已存在且请求未允许覆盖（`details.directory`）。 |
| `skill-absent` | 该层没有这个技能。 |
| `skill-ambiguous` | 两个目录注册了同一个 frontmatter 名，无法判定删除哪一个。 |

拒绝都发生在技能层目录变化之前：包先整个解在内存里、校验通过后才写入。换入失败时被替换的旧目录会从旁边目录 `rename` 回来，暂存目录在 `finally` 里删除。

## 配置

```yaml
- id: skill-install
  name: '@deepseek-ai/dsh-skill-install'
  config:
    maxBundleBytes: 16777216
    maxExpandedBytes: 67108864
```

`maxBundleBytes` 默认 16 MiB，`maxExpandedBytes` 默认 64 MiB；两者都必须是正整数，否则挂载即失败。解压期间的实际字节数一直受 `maxExpandedBytes` 约束，zip 头里声明的长度只用于提前拒绝。

## Model Experience

None, as the installer writes skill bundles for an operator-facing surface; discovery, loading, and rendering of the installed skills stay in dsh-skill.

#### KV Cache effect

无；本包既不组装也不发送供应商请求。装入技能会改变后续请求里的技能目录（`<available_skills>`）内容，因此在一次会话中途安装技能会让下一次请求的前缀与上一次不同——本包不做任何缓存规避，实际前缀变化由目录消息按既有规则以 `update: true` 的替换消息交付。

## Known Limitations and Deferred Work

- **只能写当前作用域发布的技能层。** 服务不给调用方指定目录的入口，平台管理令牌因此只能写系统层；为某个租户或用户装技能需要一条携带该作用域的调用路径。
- **一次调用只装一个技能。** 包里有多个 `SKILL.md` 会被拒绝而不是逐个装；批量上传需要一个跨技能的事务，且失败时要能回滚整批。
- **换入不是原子的跨技能操作。** 单个技能的换入是暂存目录 + 一次 `rename`，但「替换」期间存在旧目录被移到旁边的短暂窗口，同时读该目录的进程可能看不到技能；目录级原子替换依赖文件系统能力，尚未实现。
- **`list` 逐条读文件，不缓存。** 列表对每个条目都读一次 `SKILL.md`；技能层目录很大时会线性放大 I/O，尚未提供分页或按 mtime 缓存。
