# @deepseek-ai/dsh-tenant

多租户 DeepSeek Harness 部署的租户身份、请求作用域权威与注册表。此包不拥有持久状态、不注册工具；它是各多租户 provider 读取的边界。

## 形态

- `TenantId` —— 不透明的 `Branded<'TenantId'>` id，配 `TenantId(id)` 工厂；`UserId` —— 不透明的 `Branded<'UserId'>` 主体，配 `UserId(id)` 工厂。
- `Tenant` —— 认证请求所充当的已解析记录：`id`、`name`、`dataRoot`、`workspaceRoot`、可选 `toolsRoot`、可选 `enabled`、可选 `network` 出站策略，以及可选 `members`（被接纳的主体列表；缺省或为空表示对任意已认证主体开放）。
- `runWithTenant(tenant, fn)` / `currentTenant()` / `requireTenant()` —— 请求作用域租户权威；`runWithUser(user, fn)` / `currentUser()` / `requireUser()` 以同样方式携载认证主体。每项权威是一个模块级 `AsyncLocalStorage`（`withInitiator` 模式），因此每个租户或用户感知的 provider 读同一份存储。`requireTenant()` 在无 run 环境外抛 `TenantError` code `NO_TENANT_IN_SCOPE`，`requireUser()` 抛 `NO_USER_IN_SCOPE`。
- `isTenantMember(tenant, subject)` —— 主体是否被接纳进租户：`members` 缺省或为空即开放，否则主体必须在列表中。
- `tenantPartitionName(tenantId)` / `userPartitionName(user)` —— 确定性的存储分区名：消毒后的 id 前缀加抗碰撞哈希后缀，始终是安全的 PostgreSQL 标识符（≤63 字符）。租户名是 Postgres 后端所用的每租户 schema；用户名是持久 `user_id` 的安全 token 形式，供内存守卫键与容器名使用。
- `TenantRegistry`（`ctx.tenants`）—— 部署的租户记录：`register(tenant)` 返回精确 disposer、`get`、`resolve`（失败关闭地拒绝 `TENANT_UNKNOWN` / `TENANT_DISABLED`）、`resolveMember(id, subject)`（当租户列出的成员不包含该主体时追加 `NOT_A_MEMBER`）、`list`。租户也可经 cordis.yml 的 `Config.tenants` 声明（`{ id, name, dataRoot, workspaceRoot, toolsRoot?, enabled?, network?, members? }` 线上形态，其 `id` 在注册时被品牌铸造为 `TenantId`）；每条记录以 effect 挂载。
- `ctx.partitionScope`（`TenantPartitionScope`）—— 本挂载为 harness 的分区中立消费者（`settings`、`settings-file`、`credentials-local`、`storage-domain`、`workspace`）安装的请求分区。`current()` 从环境权威解析出 `{ tenant, tenantName, user?, userName?, dataRoot }` —— 名字来自 `tenantPartitionName`/`userPartitionName`，`dataRoot` 给出每租户根目录 —— 无租户时返回 `undefined`，使这些消费者留在单分区路径上。它们经 `@deepseek-ai/dsh-partition-scope` 读取，因此本包是它们唯一的 provider，删除本包不会让它们加载失败。

- `tenantDirectories(input)` —— 租户及其成员在宿主磁盘上需要存在的每一个目录：`dataRoot`、可选归档根、可选 `toolsRoot`、部署级的 `systemRoot` 与 `systemRoot/skills`、`pythonRoot`，`<workspaceRoot>` 本身及它下面的 `work` 与 `{config,skills,tools}`，以及每个成员的 `<workspaceRoot>/users/<subject>/{work,sessions}` 与 `<usersRoot>/<subject>/{work,config,skills,tools}`；父目录先于子目录，重复项只出现一次。沙箱的挂载源正是这批路径，所以 `tenant-admin` 照着这一份清单幂等建树：建目录与出挂载表之间没有第二份清单。某个根缺失表示该部署没有配置它，而不是它下面的目录不用建。
- `TENANT_TIER_DIRS`（`config`/`skills`/`tools`）、`TENANT_WORK_DIR_NAME`、`TENANT_USERS_DIR_NAME`、`TENANT_SESSIONS_DIR_NAME`、`TENANT_SKILL_DIR_NAME` —— 目录名常量。两个 container provider 按这些名字拼出挂载源，各写一份字面量会在一方改名后仍挂旧路径，而容器运行时会把缺失的绑定源静默建成空目录，故障因此出现在下游。
- `SANDBOX_CASE_MOUNT`（`/case`）、`SANDBOX_WORKSPACE_MOUNT`（`/workspace`）、`SANDBOX_SESSIONS_MOUNT`（`/sessions`）、`SANDBOX_WORKDIR_ENV`、`sandboxSessionDir()` —— 沙箱侧的挂载点与工作目录约定。`/case` 接案件工作目录 `<workspaceRoot>/work`，`/workspace` 接该主体在该案件的工作目录 `<workspaceRoot>/users/<subject>/work`，`/sessions` 接该主体的会话目录 `<workspaceRoot>/users/<subject>/sessions`；`sandboxSessionDir()` 在 `/sessions` 之下按会话 id 拼出 `/sessions/<会话 id>`，`DSH_WORKDIR` 载着同一个路径给技能与模型。两个 provider 都用这一个函数解析它：会话 id 直接成为路径分量，所以不是普通目录名的值一律不被接受，命令退回调用方给的工作目录。

隔离叠在此处而非 core：多租户 provider 对每个打开类操作调用 `requireTenant()`，并强制执行它们自持的持久 `tenant_id`/schema 绑定，因此一个请求只能寻址其认证所铸出的那个租户。

## Model Experience

### Tenant resolution and registry

#### What the model sees

无。`ctx.tenants` 与租户权威只服务 host 侧 provider：本包不注册工具、不注入提示、不写会话事件。

#### Token effect

每次请求零直接 token。

#### KV Cache effect

与活动请求无关：本包从不触碰请求前缀。

## Known Limitations and Deferred Work

- **租户记录在内存中** —— 开通即「装配中的注册」，不是持久存储；持久租户开通/注销（连同 schema 生命周期）延后到 Postgres provider 及其运维契约。
- **权威是进程本地的** —— `AsyncLocalStorage` 在单个 Node.js 进程内传播；跨副本转发在线上携带租户 id，并在接收侧用 `runWithTenant` 重新进入。
- **沙箱层根尚未由租户面持有** —— `tenantDirectories` 已接受 `systemRoot` 与 `pythonRoot`，但租户面的配置里还没有这两个键，所以这两个根及其下的技能层仍须由部署方保证存在。租户面接上这两个键之后，它们才并入同一次自动建树。
