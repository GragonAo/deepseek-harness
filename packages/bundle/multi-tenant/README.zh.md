# `@deepseek-ai/dsh-multi-tenant`

[English](README.md) | 中文

多租户 dsh 后端作为一个 profile bundle：[`cordis.patch.yml`](cordis.patch.yml) 是叠加在 [`dsh-base`](../base/README.md) + [`dsh-web-app`](../web-app/README.md) 之上的一层 patch，把共享的、本地沙箱化的执行世界换成租户容器运行时，并挂载租户载体。十三行单用户行被禁用：`session-persistence-jsonl`、`storage-json`、`settings`、`credentials`、`code-runtime`（宿主 worker-thread 运行时）、`subprocess`、`fs-sandbox`、`bash-sandbox`、`sandbox`、`permission`、`connection`（如今 [`agent-http`](../../tenant/agent-http/README.md) 拥有 `/api`）、`message-feedback`、`session-projection-cache`（后两者在 init 时预载存储域，而租户级后端在租户作用域之外无法提供该预载）。取而代之挂载十九行：`container-runtime`（`dsh-container-docker`）、`subprocess-container`、`bash-local`、`fs-container`（`root: /workspace`）、`code-runtime-container`、`workflow-container`、`session-persistence-postgres`、`storage-postgres`、`tenant-admin-postgres`、`settings-postgres`、`credentials-postgres`、`tenant`、`tenant-admin`、`tenant-auth-jwt`、`skill-tier`（`dsh-skill-tier`）、`tools-tier`（`dsh-tools-tier`）、`tools-manifest`（`dsh-tools-manifest`）、`settings-tier`（`dsh-settings-tier`）、`agent-http`。五行既有行各重钉一个值：`storage-domain`（`backend: postgres`）；`sandbox-policy`（`mode: workspace-write`）与 `approval`（`policy: ask`），因为工具层仍要经它们解析每次调用的模式；`api-gateway`（`cwd: /workspace`），使无显式 workspace 的会话解析到容器工作区而非 Host 进程 cwd；以及 `tools`（其 `mode` 默认 `both`，使租户既保留原生工具面、又多出 Code Mode 的 `run_code` 工具——后者经 `code-runtime-container` 在租户容器内执行——同时 `DSH_TOOLS_MODE` 仍可覆盖）。本地 `sandbox` 执行器被租户容器取代作为隔离边界；`permission` 被禁用是因为它的预设捆绑了一个 `danger-full-access` 模式与一个容器执行器不暴露的 `shell.sandboxMode` —— 容器始终把租户限制在租户工作区。`container-runtime` 行从 `DSH_USERS_ROOT` 读取其 `usersRoot`；[`dsh-container-docker`](../../tenant/container-docker/README.md) 挂载按 (租户, 用户) 的执行世界 —— 该主体的 `/workspace`、案件的共享 `/shared`、该主体的 `/global`（设置了 `usersRoot` 时）与工具只读挂载的 `/tools:ro`。本包无运行时 API；profile 组合器通过 `dsh.bundle.patch` 清单字段解析该 patch。

租户记录、按成员分层的用户根（`DSH_USERS_ROOT`）、租户管理的归档根（`DSH_ARCHIVE_ROOT`）、Postgres 坐标（`DSH_POSTGRES_URL`）与认证材料（`DSH_OIDC_ISSUER`/`DSH_OIDC_SECRET`）刻意留在部署方自己的 profile `cordis.patch.yml`（或环境变量）中：本层只表达 provider 替换，缺失值会在加载时大声失败，因为租户 provider 的配置字段是必填的。

## 模型体验

间接来自被插入的行：`agent-http` 校验 bearer 令牌并把网关请求限定到一个 `(tenant, user)`，容器 provider 在该 `(tenant, user)` 的容器内运行每次工具调用（挂载 `/workspace` 加 `/shared` 与 `/global`）。`tools.mode` 钉扎在标准单用户原生工具面之上追加 Code Mode 的 `run_code` 工具（及其 `tools:sdk` 提示段），其程序在该租户容器内执行。本 bundle 自身不贡献除此以外的模型可见文本。

#### KV Cache 影响

无直接影响；每个被插入行各自的包拥有其效应。

## 已知局限与后续工作

- **替换已通过 Loader 启动实证，但尚无一整回合真实 agent 回合** —— `tenant-demo/tests/multi-tenant-loader.spec.ts` 经 Loader 启动 base + web-app + 本 bundle（禁用浏览器表层行、钉住租户行、收拢确定性接缝），并断言每个被替换的 provider 都解析到位；真实 LLM + 真实 Docker/Postgres 的闭环回合仍是服务器这一步。
- **workspace 注册表按 (租户, 用户) 键控且在作用域内初始为空** —— 它惰性打开每个分区的 KV 领域，因此同步的 `list()`/`get()` 投影在首次访问时返回空，直到某个异步方法打开该 (租户, 用户) 分区（[`@deepseek-ai/dsh-workspace`](../../workspace/workspace/README.md)）。
- **两个载体互斥** —— profile 不得同时挂载 `dsh-client-connection`，否则 `agent-http` 与 `connection` 都会注册 `/api` 前缀，并在重复路由上加载失败。
- **消息反馈与会话投影缓存被禁用** —— 两者都在 init 时预载各自的存储域，而租户级 Postgres 后端在请求之外没有环境租户，该预载会抛 `NO_TENANT_IN_SCOPE`。重新启用任一个都需要租户作用域（按请求）的预载。
- **租户开通留在部署层** —— `tenant` 行以零记录启动；profile 的 patch 必须提供 `Config.tenants`。
