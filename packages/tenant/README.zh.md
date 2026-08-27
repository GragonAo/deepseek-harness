# tenant/ — 多租户隔离

[English](README.md) | 中文

在既有内核之上叠加的多租户隔离：请求作用域租户权威、JWT/OIDC 认证、Postgres (租户, 用户) 键控状态、Docker/Podman 容器执行世界、无状态 HTTP API。隔离是「这些 provider + 租户权威」的性质，而不是对 core 会话/持久化接缝的改动。

| 包 | 职责 | ctx key |
|---|---|---|
| [`tenant/`](tenant/README.md) | 租户身份、请求作用域权威、记录注册表 | `ctx.tenants` |
| `tenant-auth/` | 认证 Service Definition（`TenantAuthenticator`） | `ctx.tenantAuth` |
| `tenant-auth-jwt/` | JWT/OIDC 校验 provider | — |
| `session-persistence-postgres/` | 走 Postgres 的 `SessionPersistence`，(租户, 用户) 键控 | `ctx.sessionPersistence` |
| `storage-postgres/` | 走 Postgres 的存储 hub 后端，(租户, 用户) 键控（案件共享单位按租户存储） | 注册后端 `postgres` |
| `container/` | 容器 owner Service Definition | `ctx.containerRuntime` |
| `container-docker/` | Docker/Podman 引擎生命周期 provider | — |
| `fs-container/` | 走租户容器的 `FileSystem` | `ctx.fs` |
| `subprocess-container/` | 走租户容器的 `SubprocessRuntime` | `ctx.subprocess` |
| `api-http/` | 无状态 HTTP API 后端 + 认证中间件 | HTTP 路由 |
| `tenant-demo/` | 可运行的端到端切片装配 + 隔离测试 | HTTP 路由 |

本组内各 provider 依契约都是租户与用户感知的：每个都调用 `requireTenant()`（按用户状态再加 `requireUser()`）或读取会话控制器捕获的 `(tenant, user)`，并强制执行其自持的持久 `tenant_id`/`user_id`/schema 绑定。它们不是 `session/`、`storage/`、`fs/`/`subprocess/` 中单租户后端的直接替代，那些后端保持不受影响。
