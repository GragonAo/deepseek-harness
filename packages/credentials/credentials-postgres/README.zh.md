# @deepseek-ai/dsh-credentials-postgres

[English](README.md) | 中文

面向多租户承载层的 PostgreSQL 凭据提供者。可写的凭据映射（引用 → 值）位于当前 (租户, 用户) 分区中名为 `credentials_doc` 的存储单元里 —— 租户的 schema 加主键内嵌的 `user_id` —— 因此任何租户或用户都不再读写宿主机侧的 `.credentials.yaml`。解析分层与 `credentials-local` 完全一致，只是把受管理的文件换成了 Postgres：

```text
inherited process environment       (read-only, wins)
> postgres per-(tenant, user) store (provider-managed, writable)
> <cwd>/.env                        (read-only fallback)
> $DSH_HOME/.env                    (read-only fallback)
```

只有可写存储按 (租户, 用户) 隔离；继承环境与两层 `.env` 属于进程自身，从不属于某个租户或用户。

## 配置

无需配置。提供者解析存储中枢上已注册的 `postgres` 后端；`storage-postgres` 条目上的 `connectionString` 由部署侧提供。

## 行为

- **逐调用解析。** 每次 `resolve()` 都从 Postgres 读取当前 (租户, 用户) 的映射，因此改动能立即到达下一次操作，无需监视器。继承环境在最先检查，因此部署侧注入进程的 `DEEPSEEK_API_KEY` 无需数据库往返即可解析。
- **按 (租户, 用户) 键控写入。** `set()`/`unset()` 要求租户与用户作用域，并向该 (租户, 用户) 的分区写入一条 `ref` 记录；作用域之外失败关闭，`resolve()` 只回退到环境与 `.env` 层。
- **空值即不存在。** `set()` 拒绝空字符串；`resolve()` 把空存储值视为不存在，因此 unset 与空值语义不分裂。
- **继承环境不可被遮蔽。** 当进程环境已提供某引用时，`set()` 与 `unset()` 拒绝执行：那里的写入不会产生任何效果。
- **`.env` 回退依附于启动环境。** 仅当产品 CLI 提供了启动环境快照时它们才解析；裸组合只解析进程环境本身。

## 模型体验

通过调用 `ctx.credentials.resolve()` 的凭据消费者间接生效；提供者只存储并返回值，自身不渲染任何模型可见文本。

#### KV 缓存影响

无直接失效；相关的请求前缀变化由消费方能力负责。

## 已知限制与后续工作

- **无跨进程热更新。** 其他进程直接在 Postgres 中修改的值，到下一次 `resolve()`（始终新鲜）才会被观察到；向凭据接缝推送未经请求的通知属于暂缓事项。
- **每个 (租户, 用户) 一份文档，无逐引用租约。** 对同一引用的并发写入以最后写入为准；单个凭据上没有比较并交换。