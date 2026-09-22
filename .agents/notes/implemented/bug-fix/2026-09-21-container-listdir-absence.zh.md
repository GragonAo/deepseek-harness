# Agent Note: 容器目录列举把缺失报告为缺失

Status: implemented

[English](2026-09-21-container-listdir-absence.md) | 中文

## 问题

`FileSystem.listDir` 区分"目录不存在"与"目录不可读"：`dsh-fs-local` 在目标不存在时抛 `FS_NOT_FOUND`，在目标存在但不是目录时抛 `FS_NOT_DIRECTORY`，调用方依赖这一区分。发现类代码把缺失的 skill 或 tool 根当作空根 —— 多租户 skill 提供方自己的缺失根路径就通过 `isAbsentSkillPathError` 接受 `FS_NOT_FOUND` —— 而把其它任何错误码当作真实故障。

`dsh-fs-container` 经容器运行时用 `find` 实现 `listDir`，并把所有非零退出码都归类为 `FS_IO_ERROR`。`find` 会把缺失目录写到 stderr 并返回非零退出码，于是在多租户部署上，缺失的默认 skill 根（`/workspace/.dsh/skills`）以 I/O 故障而非缺失的形式浮现。该错误逃出提供方的 `list`，被 skill 注册表捕获，注册表随即丢弃**整个提供方** —— 连同它已经发现的环境层级 skill 一起丢掉，只因为一个坏根。目录返回为空，而响应里任何地方都没有 skill 报错。

## 决策

`listDir` 在兜底分支之前先识别 `find` 的两条可区分诊断信息，与同文件中 `readError` 和 `stat` 路径一致：

- `No such file` → `FS_NOT_FOUND`
- `Not a directory` → `FS_NOT_DIRECTORY`
- 其它 → `FS_IO_ERROR`

缺失目录的归类正是 `dsh-fs` 在抽象方法 JSDoc 中为 `listDir` 声明的契约；该 JSDoc 现在写明这三个错误码，并记录调用方依赖这一区分。`dsh-fs-container` 被拉回与该契约一致；消费方无改动。

## 被否掉的备选

- **在 `isAbsentSkillPathError` 里同时接受两种错误码。** 把调用方放宽到容忍 `FS_IO_ERROR` 即视为缺失，会同时吞掉真实的读取故障，而且会让其它每一个 `listDir` 消费方（包括 tool 发现）继续把缺失根当作坏根。选用：修正不符合契约的提供方。
- **列举前先用 `stat` 探测。** 为取回 `find` 本已报告的信息，每次列举多一次往返，并且会与"探测和列举之间目录被删除"竞态。
- **任何非零退出码都返回空列举。** 这会把权限故障或运行时不可达的错误一并丢弃，于是真正坏掉的根与空根无法区分。

## 后果

**所得：** 缺失、非目录与 I/O 故障经容器后端可区分，与经本地后端完全一致，因此缺失的根只损失它自己的候选。在多租户部署上，案件层、用户全局层与系统层 skill 现在能进入目录。

**成本与暂缓工作：** 该归类读取 `find` 的英文 stderr 文本，这是 `dsh-fs-local` 同样具有的限制 —— 它是兄弟后端本就依赖的同一契约，不是新增依赖。此次暴露出的弱点 —— 某个根抛错时 skill 注册表丢弃整个提供方、连同它已经发现的候选项 —— 已在同一改动中修复：提供方现在隔离失败的根、记录它，并报告不完整观测，这正是[目录刷新 note](../feature/2026-07-27-skill-catalog-hot-refresh.md) 早已对 watcher 失败提出的要求。

### 验证

`packages/tenant/fs-container/tests/container.spec.ts` 中三个测试各自挂载一个 stderr 带一条诊断信息的列举结果，分别断言 `FS_NOT_FOUND`、`FS_NOT_DIRECTORY` 与 `FS_IO_ERROR`；去掉该归类时第一个测试失败，加上后套件 9/9 通过。`packages/fs/fs-local/tests/filesystem.spec.ts` 与 `fsio.spec.ts` 早已为本地后端断言同样的两个可区分错误码，这正是容器后端现在对齐的契约。
