# @deepseek-ai/dsh-tenant-demo

[English](README.md) | 中文

可运行的端到端多租户切片。它把 bearer-JWT 认证（[`tenant-auth-jwt`](../tenant-auth-jwt)）、每租户 Postgres 会话（[`session-persistence-postgres`](../session-persistence-postgres)）、每租户容器执行世界（[`container-docker`](../container-docker) + [`subprocess-container`](../subprocess-container) + [`fs-container`](../fs-container)）与租户 HTTP API（[`api-http`](../api-http)）装配到一个可启动入口 `assembleDemo` 之后。

demo 操作逐请求证明整条链路：认证 → 解析租户 → 在该租户自己的容器里跑一次容器工具调用（其工作空间挂载在 `/workspace`、工具挂载在 `/tools`）→ 在世界内读回结果 → 把一条会话事件持久化到该租户的 schema。

## 运行

```sh
docker compose -f packages/tenant/tenant-demo/docker-compose.yml up -d

TEST_POSTGRES_URL=postgres://dsh:dsh-local@127.0.0.1:5432/dsh \
  pnpm exec vitest run packages/tenant/tenant-demo/tests
```

集成测试在没有 `TEST_POSTGRES_URL` 或没有可用的容器运行时时自跳过。用 `TEST_CONTAINER_RUNTIME=podman` 使用 Podman。测试会预热容器运行时所拉起 `dsh-tool-exec:latest` 镜像；先用 `docker build -f packages/tenant/container-docker/docker/Dockerfile -t dsh-tool-exec:latest .` 构建它。

## 模型体验

### 租户作用域 demo 请求

#### 模型看到什么

无。切片经 `ctx.tenantHttpApi` 服务外部 HTTP 客户端；不提供工具、提示词或会话事件。

#### Token 影响

每个请求零直接 token。

#### KV Cache 影响

与在线请求无关：本包从不触碰请求前缀。

## 已知限制与延期工作

- **仅装配。**本包为切片在手搓的 Cordis context 上启动 provider；生产部署经 Loader 与 `cordis.yml` 装配它们。
- **没有完整 HTTP 请求/响应 schema。**正文是自由形式 JSON；操作为单槽位。
- **没有 agent 循环。**demo 操作直接跑一次容器工具调用 — 不派发模型回合。