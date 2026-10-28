# deliverables/ — 交付物声明

[English](README.md) | 中文

模型侧"这一轮交付了哪些文件"的声明。只有一个 **产品** 包：声明属于做出它的那一个 agent 会话，没有可替换的 provider 契约。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-present/`](tool-present/README.md) | 记录一轮交给用户的文件，并按轮投影出来。 | （注册在 `ctx.tools`、`ctx.sessionProjections` 上） |

工具、校验、投影与渲染契约见子包 README。

事件与投影载荷见 [docs/subsystems/session.zh.md](../../docs/subsystems/session.zh.md)。
