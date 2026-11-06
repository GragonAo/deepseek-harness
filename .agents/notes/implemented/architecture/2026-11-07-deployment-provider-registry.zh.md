# Agent Note：模型厂商注册表是部署级的，模型按轮次生效

Status: implemented

[English](2026-11-07-deployment-provider-registry.md) | 中文

> 一条模型路（id、API 方言、端点、模型清单、凭据）原先只来自部署配置，改一家厂商就等于改配置、重编镜像、重启租户宿主；而用户的模型选择只在**新会话**上生效，因为那是一个会话默认值，而不是提问的一部分。

## 问题

`llm-pi-ai` 从 `cordis.yml` 的 `config.providers` 解析路由，凭据挂在 `apiKeyEnv` 变量上。于是每次改厂商都是一次发布。产品侧唯一的写入路径是对话页的"发现并采纳模型"流程，它写的是**每个用户自己的设置文档** —— 用户能凭空造出一条厂商路由，而企业部署没有任何地方能集中配置一条。

模型选择器还有一个自身的限制：它写 `session.selectModel`，即**会话默认值**。对一条已经在跑的会话，这要么改了但用户看不见效果，要么在宿主没有活着的 Agent 时直接失败。想表达"这个问题用那个模型"的用户没有地方可说。

## 决定

- **注册表是部署级的，不按租户分。** `@deepseek-ai/dsh-llm-providers-postgres` 拥有一个 `shared: true` 的 KV 单元（`llm_providers`），厂商目录放在该单元的 `hasGlobal` 单例里——一份 `{ providers: [...] }` 文档，而不是一张逐厂商成行的表，并且**只在任何租户作用域之外打开一次**。存储后端对这样打开的 shared 单元走 `dsh_system` schema，于是所有租户读到同一份路由，管理员为整个 harness 配一次。在租户作用域外打开的 per-user 单元仍然直接失败；只有 shared 单元可以是部署级的。
- **定义与实现分离。** `dsh-llm` 增加 `LlmProviderStore`（`ctx.llmProviders`：`list`/`refresh`/`snapshot`/`upsert`/`remove`/`onChange`）；PostgreSQL 包是它的一个 provider。
- **配置降为兜底层。** 路由解析把 `config.providers` 与注册表快照合并，注册表优先；注册表为空时行为与以前完全一致。只有一份注册表就意味着一家厂商一条凭据 —— 已经没有租户维度可以撞车。
- **写入对下一次请求生效。** 存储在变更时通知，`llm-pi-ai` 重注册路由与目录；不需要重启进程，共用 PostgreSQL 的副本在下一次 `refresh()` 就能看到别人的写入。
- **一条提问可以自带模型。** `session.prompt` 接受可选的 `model: { provider, model, reasoningEffort? }`。宿主用 `session.selectModel` 同一个解析器校验它（同样的路由校验、同样的图片模态准入），并在消息入队**之前**应用到活着的 Agent 上，于是这一轮就走新路由，而会话默认值不动。这条路径让已经在跑的会话也能换模型；`session.selectModel` 仍然负责改会话的持久默认值。
- **管理走 RPC**：`llm.addProvider`、`llm.updateProvider`、`llm.removeProvider` 与 `llm.providers`、`llm.models` 并列，上层业务面调用时不再带案件维度。凭据只写不读：视图只报 `apiKeyConfigured`。写方法不带权限位 —— harness 信任自己的网络，角色判断留给上面的业务层。
- **用户面收窄。** 对话页只读目录，并把选中的路由随每条提问发过来；"发现并采纳"的写入路径已删除，选择器也不再写会话默认值。

- **交叉引用。** 本 note 扩展的选择面是 [Web 对话输入区的会话模型选择](../feature/2026-07-24-web-session-model-selector.md)；本项目不改的默认值由 [默认模型跟随选择器](../feature/2026-08-07-default-model-follows-the-picker.md) 负责；与 `selectModel` 共用的图片准入见 [原子化的 Web 图片准入](../bug-fix/2026-07-29-atomic-web-image-admission.md)。

## 验证

注册表包的测试证明被访问的只有 system schema、整份目录始终是一个全局值、在租户作用域内发出的写入同样落在那里、且所有租户读到同一份目录。`llm-pi-ai` 的注册表测试与 api-proxy 的厂商测试覆盖合并与写入路径；api-proxy 的 prompt 测试覆盖自带模型被应用与被拒绝。在部署的租户宿主（130）上：空注册表只服务配置里的路由且 `source: 'config'`；`addProvider` 后下一次读即出现 `source: 'registry'` 并进入 `llm.models`；`updateProvider` 在不给 `apiKey` 时保留已存凭据；`removeProvider` 回落到配置。管理页不再需要案件 ID，管理的就是这一份注册表；一条已存在的对话会话在选择器里换模型后，那一轮就用新模型作答。

## 已知限制

注册表是一个全局值，所以共用同一个 PostgreSQL 库的两个部署会共用厂商路由。要分开就需要在单元上加部署（或租户组）键，并有一条从传输配置读它的解析路径。
