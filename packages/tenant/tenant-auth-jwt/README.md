# @deepseek-ai/dsh-tenant-auth-jwt

[`dsh-tenant-auth`](../tenant-auth) seam 的 JWT/OIDC provider。它校验 bearer token 并返回由其已验证声明证明的 [`TenantPrincipal`](../tenant-auth)：`tenantId` 取自可配置的声明，`subject` 取自标准 `sub`，可选 scopes 取自 `scope` 声明。不携带 `tenantId` 声明的 token 被认证为平台主体：该声明的缺失即是“凭据未指明租户”的陈述，因此管理载体接纳它，而服务租户的载体拒绝它。

## 配置

```yaml
- id: tenant-auth
  name: '@deepseek-ai/dsh-tenant-auth-jwt'
  config:
    issuer: 'https://keycloak.example/realms/enterprise'
    audience: 'dsh-api'          # optional; when set, tokens must match
    jwksUri: 'https://keycloak.example/realms/enterprise/protocol/openid-connect/certs'
    tenantIdClaim: 'tenantId'    # default
```

`jwksUri`（经 JWKS 的 RS256）或 `secret`（HS256 共享密钥，用于本地/开发 token）必须二选一；同时提供或都不提供会在加载时大声失败。`clockToleranceSeconds` 默认为 `30`。

算法按模式锁定：`secret` 用 HS256、`jwksUri` 用 RS256 — token 绝不会以更弱的方案被接受。

## Model Experience

### Token verification and tenant principal

#### What the model sees

无。校验在 `ctx.tenantAuth` 传输层运行，绝不触及模型：没有工具、提示词或会话事件。

#### Token effect

每个请求零直接 token。

#### KV Cache effect

与在线请求无关：本包从不触碰请求前缀。

## Known Limitations and Deferred Work

- **远程 JWKS 拉取无法按调用中止** — `authenticate` 契约不携带 `AbortSignal`，调用方无法取消阻塞的发现拉取。
- **没有角色到租户映射** — 租户 id 直接来自某一声明；从角色或组派生租户的部署需要额外的映射 provider。
