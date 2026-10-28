# deliverables/ — delivered-file declaration

English | [中文](README.zh.md)

The model-facing declaration of what a turn delivers. It is one **product** package because the declaration belongs to the one agent session that made it; there is no replaceable provider contract.

| Package | Role | ctx key |
|---|---|---|
| [`tool-present/`](tool-present/README.md) | Records the files a turn hands to the user and projects them per turn. | (registers on `ctx.tools`, `ctx.sessionProjections`) |

The child README owns the tool, validation, projection, and rendering contract.

The event and projection payloads are documented on [docs/subsystems/session.md](../../docs/subsystems/session.md).
