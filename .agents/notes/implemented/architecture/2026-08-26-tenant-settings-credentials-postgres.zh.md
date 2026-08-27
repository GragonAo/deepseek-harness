# Agent Note：租户键控的设置与凭据迁移到 Postgres

Status: implemented

[English](2026-08-26-tenant-settings-credentials-postgres.md) | 中文

## 问题

多租户承载层继承了单用户的 `settings-file` 与 `credentials-local` 提供者。二者都把租户数据写到宿主机文件系统 —— `<tenant.dataRoot>/settings.yaml` 与 `<tenant.dataRoot>/.credentials.yaml` —— 因此多副本部署无法共享状态，租户受管理的配置也会以文件形式残留在宿主机上，任何宿主机侧文件读取都可能把错误租户的内容暴露出去。无状态化要求 agent 平面的每项配置事实都进入租户键控的持久化存储，不留下宿主机侧受管理文件。

## 决策

发布两个基于 Postgres 的提供者，并让多租户 bundle 切换到它们，仅为承载层替换文件提供者 —— 单用户 bundle 保持 `settings-file` 与 `credentials-local` 不变。

- **`@deepseek-ai/dsh-settings-postgres`** —— 一个 `SettingsProvider`，其原始文档是名为 `settings_doc`、只有一张 `section` 表的存储单元。`load()` 从当前租户的 schema 读取整份文档，并在任何租户作用域之外返回空文档（失败关闭，不发查询）；`persist(ns, section)` 通过 `putRecord` 写入一条命名空间记录。单元句柄按租户懒加载，释放时关闭。
- **`@deepseek-ai/dsh-credentials-postgres`** —— 一个 `CredentialProvider`，其可写映射是名为 `credentials_doc`、只有一张 `ref` 表的存储单元。解析分层与 `credentials-local` 完全一致，只是把受管理文件换成 Postgres：继承的进程环境（只读、最高优先级）→ 租户存储 → 启动环境携带的 `.env` 回退。`resolve()` 每次调用都读当前租户的映射，改动无需监视器即可到达下一次操作。
- **bundle 切换** —— `packages/bundle/multi-tenant/cordis.patch.yml` 禁用基础 `settings` 与 `credentials` 行，插入 `settings-postgres` 与 `credentials-postgres`。存储中枢已有的 `postgres` 后端（已为 `storage-domain` 与 `session-persistence-postgres` 挂载）承载这两个单元，因此不引入新的连接介质。

两个提供者都声明 `static inject = [storageBackendServiceKey('postgres')]`，使激活不会与后端注册竞争，并通过 `ctx.storage.backend.get('postgres')` 解析后端。

## 已考虑的替代方案

- **给 `settings-file`/`credentials-local` 加 Postgres 模式** —— 会把租户关注点塞进拥有监视器、写锁与原子文件渲染的单用户提供者，而这些都对 schema 行毫无意义。选择：独立提供者。
- **两个提供者共用一个 KV 单元** —— 把两个独立能力耦合到同一 schema/版本上。选择：`settings_doc` 与 `credentials_doc` 保持独立。
- **每个命名空间存一条记录，还是放进 global 槽的单 JSON blob** —— 逐记录（`section`/`ref` 表）让单个命名空间的写入成为单行 upsert，避免对整份文档做读改写。选择：记录表；不使用单元 `global` 槽。

## 影响

**收益：** agent 平面不再持有宿主机侧受管理的设置或凭据文件；设置与凭据按租户持久化在 Postgres 中并在副本重启后存续；`postgres` 后端的 `Unit` 路由（每租户一个 schema）已然强制跨租户隔离。仅测试用组合与已部署的承载层都通过真实 Loader 路径、挂载存储中枢后启动这两个提供者。

**代价与后续工作：** `SettingsProvider` 在进程内每个租户首次写入时加载其文档（只读请求仍看到默认值），与 `settings-file` 一致；让读取按需加载需要把基类读路径从同步拓宽为异步。code-runtime 与 workflow 执行器仍在宿主机进程内运行模型代码，仍是亟待容器化的宿主机侧文件访问面。

### 验证

对两个新包 tsconfig 及 bundle 执行 `pnpm exec tsc -b` 通过；两个提供者测试套件（逐租户往返、隔离、作用域外失败关闭、环境遮蔽）以及每个提供者各一个真实组合套件，通过 Loader + 模拟 postgres 执行器检验通过；`packages/bundle/multi-tenant/tests/multi-tenant.spec.ts` 断言已禁用的文件提供者行与已挂载的 Postgres 行。