# @deepseek-ai/dsh-tool-executor-in-process

English | [中文](README.zh.md)

The **`InProcessToolExecutor`** (`ctx.toolExecutor`) is the verification backend of the [tool-execution seam](../tool-executor/README.md): it runs a tool body inline in the same JavaScript realm, so mounting it leaves tool behavior identical to a deployment with no executor — the body executes here exactly as the registry dispatched it before the seam existed. It is the baseline, **not a security boundary**: the hard multi-tenant boundary is a future `container` provider.

## Behavior

| Concern | Handling |
|---|---|
| Inline body | Runs `request.body` directly and resolves its canonical value. |
| Body rejection | Propagates unchanged, so the tool registry's error path keeps the original error object. |
| Pre-aborted signal | Resolves a `failure` of kind `abort`. |
| Missing body | Resolves a `failure` of kind `execution-substrate` (an in-process world cannot resolve `toolId` without an inline body). |

See the seam's [Service API](../tool-executor/README.md#service-api-ctxtoolexecutor) for the `execute()` contract.

## Model Experience

None, as this provider only forwards the tool registry's inline bodies in-process and adds no model-visible content or token.

#### KV Cache effect

No direct invalidation; this provider does not contribute request tokens.

## Known Limitations and Deferred Work

- **No isolation** — same-realm execution is not a security boundary; a hard multi-tenant boundary needs the `container` provider (deferred).
- **In-process only** — requests without an inline body cannot resolve `toolId`, so this provider is the baseline, not the multi-tenant execution world.
