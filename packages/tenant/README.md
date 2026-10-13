# tenant/ — 多租户隔离

在既有内核之上叠加的多租户隔离：请求作用域租户权威、JWT/OIDC 认证、Postgres (租户, 用户) 键控状态、Docker/Podman 容器执行世界、无状态 HTTP API。隔离是「这些 provider + 租户权威」的性质，而不是对 core 会话/持久化接缝的改动。

| 包 | 职责 | ctx key |
|---|---|---|
| [`tenant/`](tenant/README.md) | 租户身份、请求作用域权威、多租户部署的记录注册表 | `ctx.tenants` |
| `tenant-auth/` | 认证 Service Definition（`TenantAuthenticator`）：把凭据校验为已认证的租户主体 | `ctx.tenantAuth` |
| `tenant-auth-jwt/` | JWT/OIDC 校验 provider（JWKS 的 RS256，或共享密钥的 HS256） | — |
| `agent-http/` | 面向 agent 的 HTTP 载体：在既有 `ctx.apiProxy` fetch 面之上做 bearer 鉴权与请求作用域租户权威 | `ctx.agentHttp` |
| `tenant-admin/` | 租户管理服务：按作用域授权的租户 CRUD、成员纳管与 partition/目录生命周期 | `ctx.tenantAdmin` |
| `tenant-admin-http/` | 租户管理 HTTP 载体：仅由管理作用域授权的管理面 `/admin`，提供租户 CRUD、成员纳管与用户层供给 | `ctx.tenantAdminHttp` |
| `tenant-admin-postgres/` | 租户管理面的 Postgres 持久化 provider：`tenant_record` 表 + 每租户 schema 生命周期 | — |
| `tenant-questions/` | 多租户问答通道：把会话里的提问记为 `user-question/*` 会话事件，并让业务面通过 `tenantQuestion.list` / `tenantQuestion.answer` 作答 | `ctx.tenantQuestions` |
| `tenant-app/` | 租户服务的唯一启动入口：自有配置 + 手写 Cordis 组合，不依赖 dsh 的 bundle、CLI 与 Loader | — |
| `session-persistence-postgres/` | 走 Postgres 的 `SessionPersistence`，(租户, 用户) 键控：每租户一个 schema，事件溯源日志按 JSON 行存储 | `ctx.sessionPersistence` |
| `storage-postgres/` | 走 Postgres 的存储 hub 后端，(租户, 用户) 键控：每租户一个 schema，KV 按行存 JSON 文档（案件共享单位按租户存储） | 注册后端 `postgres` |
| `settings-tier/` | 会话/案件/用户全局/系统 环境配置层根：把 (租户, 用户, 会话) 解析为四个宿主配置目录，并按 会话 > 案件 > 用户全局 > 系统 合并各命名空间的文件 | `ctx.settingsTiers` |
| `skill-tier/` | 案件/用户全局/系统 skill 层根：把 (租户, 用户) 解析为三个宿主 skill 目录，按 案件 > 用户全局 > 系统 取优先级 | `ctx.skillTiers` |
| `tools-tier/` | 案件/用户全局/系统 工具清单层根：把 (租户, 用户) 解析为三个宿主工具目录，按 案件 > 用户全局 > 系统 取优先级 | `ctx.toolTiers` |
| `tools-manifest/` | 声明式工具清单加载器：把环境层目录里的纯数据 YAML 清单映射为在租户容器中执行的排序工具 | — |
| `tools-restriction/` | 按层声明的工具限制：把每个环境工具层目录携带的保留 `restriction.yaml` 施加到每个新建 agent 自己的作用域，使该层收窄其提示词与生成的 SDK 声明可以点名的工具 | — |
| `object-store/` | 对象存储投递：把案件/用户作用域内的文件签名上传到 S3 兼容存储，并把公开下载地址作为模型可见结果返回的工具 | — |
| `container/` | 容器 owner Service Definition | `ctx.containerRuntime` |
| `container-docker/` | Docker/Podman 引擎生命周期 provider | — |
| `container-k8s/` | Kubernetes 容器运行时 provider：每个 (租户, 用户) 一个裸沙箱 Pod，按 podIP 寻址 | — |
| `container-transport/` | 容器运行时 provider 共用的传输接缝：启动运行时 CLI，以及经 HTTP 访问已启动沙箱的 tool-exec 服务 | — |
| `fs-container/` | 走租户容器的 `FileSystem` | `ctx.fs` |
| `subprocess-container/` | 走租户容器的 `SubprocessRuntime` | `ctx.subprocess` |
| `terminal-container/` | 走租户沙箱的持久终端 backend（`ctx.terminals` 的 provider）：每个会话一个交互式 shell，走容器运行时分配的 PTY | 注册 backend 类型 `shell` |

本组内各 provider 依契约都是租户与用户感知的：每个都调用 `requireTenant()`（按用户状态再加 `requireUser()`）或读取会话控制器捕获的 `(tenant, user)`，并强制执行其自持的持久 `tenant_id`/`user_id`/schema 绑定。它们不是 `session/`、`storage/`、`fs/`/`subprocess/` 中单租户后端的直接替代，那些后端保持不受影响。
