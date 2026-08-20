# @deepseek-ai/dsh-tool-executor-process

English | [中文](README.zh.md)

The **`ProcessToolExecutor`** (`ctx.toolExecutor`) runs each tool body in its own execution worker — a forked Node process speaking a stdio NDJSON protocol — so a body no longer runs beside session, agent, and credential state. It is the first real agent-plane/execution-plane split behind the [tool-execution seam](../tool-executor/README.md): the worker resolves a call by the tool's stable control-plane `name` against its own body registry, so no function ever crosses the process boundary. A bare process is still containment, not a security boundary — the hard multi-tenant boundary is a future `container` provider.

## Behavior

| Concern | Handling |
|---|---|
| Body resolution | Worker-side, keyed by `request.name`; `request.body` never crosses the boundary. |
| Worker lifecycle | One standing worker serves many calls; disposal terminates it and awaits exit. |
| Pre-aborted signal | Resolves a `failure` of kind `abort` without contacting the worker. |
| Live abort / expiry | Forwards an `abort` frame; the worker cancels exactly that call and reports `abort`. |
| Worker death | Resolves every in-flight call as a `failure` of kind `execution-substrate`. |

See the seam's [Service API](../tool-executor/README.md#service-api-ctxtoolexecutor) for the `execute()` contract.

## Model Experience

None, as this provider only routes the tool registry's body executions into a worker process and adds no model-visible content or token.

#### KV Cache effect

No direct invalidation; this provider does not contribute request tokens.

## Known Limitations and Deferred Work

- **Containment, not isolation** — a bare process shares the host kernel; a hard multi-tenant boundary needs the `container` provider (deferred).
- **Demo bodies only** — this first cross-process stage ships a demo body registry (`exec:pid`, `exec:echo`, `exec:wait`); mounting first-party execution-world tools (`read`, `glob`, …) by name is the next stage.
- **No output byte caps** — the worker reports the body's value without a size bound; a cap belongs in the execution-world config.