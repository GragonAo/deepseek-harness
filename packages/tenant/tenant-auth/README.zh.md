# @deepseek-ai/dsh-tenant-auth

[English](README.md) | 中文

多租户 DeepSeek Harness 部署的租户认证 Service Definition（`ctx.tenantAuth`）。

## 形态

- `TenantPrincipal` — 校验成功的结果：`tenantId`、`subject`、可选 `scopes`。
- `TenantAuthError` — 结构化错误，`code` 为 `MISSING_CREDENTIAL` 或 `INVALID_TOKEN`。
- `TenantAuthenticator`（`ctx.tenantAuth`）— 抽象的 Service Definition。provider 继承它、实现 `authenticate(credential)` 并作为该服务加载。已交付的 provider 是 [`@deepseek-ai/dsh-tenant-auth-jwt`](../tenant-auth-jwt)。

认证只证明身份：provider 返回已认证的 `tenantId`，API 层经 `ctx.tenants` 解析租户记录并进入 `runWithTenant`。一个请求只能寻址其凭据所属的租户。

## 模型体验

### 凭据校验

#### 模型看到什么

无。`ctx.tenantAuth` 只服务 API 传输层：不注册工具、不注入提示词、不写会话事件。

#### Token 影响

每个请求零直接 token。

#### KV Cache 影响

与在线请求无关：本包从不触碰请求前缀。

## 已知限制与延期工作

- **没有授权策略** — principal 携带 scopes，但该 seam 不强制执行访问检查；授权是 API 层的职责。
- **契约没有取消信号** — `authenticate` 无法转发请求中止；JWT provider 的远程 JWKS 拉取无法按调用中止。