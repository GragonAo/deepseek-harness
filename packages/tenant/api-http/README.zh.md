# @deepseek-ai/dsh-api-http

[English](README.md) | 中文

无状态租户 HTTP API（`ctx.tenantHttpApi`）。一条精确路由经 `ctx.tenantAuth` 认证 bearer 凭据、经 `ctx.tenants` 解析租户（对未知/禁用失败关闭）、进入 `runWithTenant`，并运行单个已注册的请求操作。该进程层不保留任何 agent 或会话状态 — 操作从租户作用域及其背后的存储/容器 provider 派生一切。

## 配置

```yaml
- name: '@deepseek-ai/dsh-api-http'
  config:
    path: '/v1/run'
```

它注入 `webServer`（路由注册）、`tenantAuth` 与 `tenants`。装配方调用 `ctx.tenantHttpApi.register(operation)`，其中 `operation({ tenant, principal, body })` 在租户作用域内运行。

## 模型体验

### 认证的租户作用域 HTTP 请求

#### 模型看到什么

无。`ctx.tenantHttpApi` 路由服务外部 API 客户端而非模型：没有工具、提示词或会话事件。

#### Token 影响

每个请求零直接 token。

#### KV Cache 影响

与在线请求无关：本包从不触碰请求前缀。

## 已知限制与延期工作

- **单个操作与单条路由。**该服务是单槽位端点；多路由或带 schema 校验的请求/响应表面不在切片内。
- **除租户外没有按调用授权。**`principal.scopes` 转发给操作但不在此强制执行。
- **正文按 JSON 解析且无大小上限** — 由操作持有方限制完整结果。