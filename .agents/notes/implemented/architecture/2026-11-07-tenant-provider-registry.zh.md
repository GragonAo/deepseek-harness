# Agent Note: 租户的厂商与凭据放进 PostgreSQL

Status: implemented

[English](2026-11-07-tenant-provider-registry.md) | 中文

> 模型路由（id、API 方言、端点、模型清单、凭据）此前只来自部署配置，改一家厂商就要改配置、重建镜像、重启租户宿主；而对话页又让用户自己往设置文档里写模型，与企业部署"管理员配、用户只选"的定位相反。

## 问题

`llm-pi-ai` 从 `cordis.yml` 的 `config.providers` 解析路由，凭据再靠 `apiKeyEnv` 指到环境变量。于是每个厂商改动都是一次部署：配置、镜像、重启，而且每个租户各来一遍。同时产品侧唯一的写入路径是对话页的"发现并选用模型"，它改的是每用户的设置文档——用户可以自己造一条厂商路由，而企业部署没法集中配置。

## 决定

- **厂商记录进租户作用域存储。** `@deepseek-ai/dsh-llm-providers-postgres` 拥有一个 `shared: true` 的 KV 单元（`llm_providers`，表 `provider`，每个厂商 id 一行 JSON）。`shared` 表示"这个租户共用"，没有用户维度：当前不存在用户级 LLM 配置。
- **定义与实现分开。** `dsh-llm` 新增 `LlmProviderStore`（`ctx.llmProviders`：`list`/`refresh`/`snapshot`/`upsert`/`remove`/`onChange`），PostgreSQL 包只是它的一个 provider。
- **配置降级为兜底层。** 路由解析把 `config.providers` 与注册表快照合并，注册表优先；注册表为空时行为与改造前一致。凭据按当前请求的租户解析，同一个 provider id 在不同租户间不会共用 key。
- **写入对下一次请求生效。** 注册表变更会通知，`llm-pi-ai` 重新注册路由与目录；不需要重启进程，共用 PostgreSQL 的多个副本在下一次 `refresh()` 也能看到别人的写入。
- **管理面是 RPC**：`llm.addProvider`、`llm.updateProvider`、`llm.removeProvider`，与 `llm.providers`、`llm.models` 并列。凭据只写不读，视图只报 `apiKeyConfigured`。写方法不带权限位——harness 信任自己的网络，角色校验留在上层业务。
- **用户面收窄。** 对话页只读目录并调用 `session.selectModel`，"发现并选用"这条写路径已删除。

## 验证

注册表包测试、`llm-pi-ai` 租户注册表测试、api-proxy 提供商测试覆盖合并、凭据解析与写入路径。在 130 的租户宿主上：空注册表只服务配置层路由并标 `source: 'config'`；`addProvider` 之后下一次读就带上 `source: 'registry'` 并出现在 `llm.models` 里；`updateProvider` 在请求不带 `apiKey` 时保留既有凭据；`removeProvider` 回落到配置层。对话页在真实登录下重新展开菜单就能看到新模型。

## 已知限制

路由**拓扑**是进程级的。一个进程服务多个租户时，两个租户给同一个 provider id 配了不同端点，取最后解析出的那一套；凭据不共享。要按租户配不同端点，需要按租户派生路由 id，或让解析层按租户读取传输配置。
