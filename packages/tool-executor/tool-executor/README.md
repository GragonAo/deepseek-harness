# @deepseek-ai/dsh-tool-executor

English | [中文](README.zh.md)

The **`ToolExecutor`** (`ctx.toolExecutor`) defines WHAT an execution world does — run one tool body against its validated arguments and report a canonical lossless-JSON value — without saying HOW. It is the seam the agent-plane/execution-plane split routes through: every tool body that leaves the agent plane executes behind this service, so a deployment mounts one provider per world (`in-process`, a hard `container`, …) without touching the tool registry.

This package owns the Service Definition role of the capability seam ([capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) and the [agent/execution plane proposal](../../../.agents/notes/proposed/architecture/2026-08-20-agent-execution-plane.md)): providers subclass `ToolExecutor` and register the service; the Consumer is the tool registry (`dsh-tools`). The executor knows nothing about tools, sessions, or policy: it is handed a body identity, validated arguments, and an abort signal, and it returns a value or failure.

## Service API (`ctx.toolExecutor`)

| Member | Semantics |
|---|---|
| `execute(request)` | Run one body identified by `request.toolId` with `request.arguments`. Resolves with a `failure` FIELD for every execution failure (`ToolExecutionFailure`: `exception`, `abort`, `invalid-output`, `execution-substrate`); it rejects only for caller misuse of the Service Definition contract (e.g. a request submitted after disposal). |
| `isolation` | Readonly descriptor: the execution substrate (`'in-process'`, `'process'`, `'container'`). A label for deployments and diagnostics, **not a security claim**. |

Semantics every implementation must honor (contract details in the class JSDoc): arguments and the returned value are complete lossless JSON; a body sees only its abort signal — no agent, session, approval, or registry context — so body execution cannot reach agent-plane state; disposal terminates in-flight executions and awaits their exit before completing.

## Vocabulary

`ToolExecutionRequest` (`toolId`, `arguments`, `signal`, `body?`) carries everything the execution acts on — defaulting (time budgets, output caps) is the provider's validated config, never a hidden `??` inside `execute()`. `arguments` and the returned `value` are `ToolExecutionValue`, the service-local structural equivalent of the session's canonical `JsonValue` that keeps this Service Definition independent of sessions (the `CodeJsonValue` precedent in `dsh-code-runtime`). `ToolBodyId` is a branded opaque id the agent plane mints at registration and the execution world resolves to its body. The optional `body` field carries the body inline when the execution world is this process; a cross-process world that receives no inline body resolves `toolId` in its own registry. `ToolExecutionOutcome` reports the lossless-JSON `value?` and the `failure?` (`ToolExecutionFailure`: `kind` + model-feedable `message`). `ToolBody` / `ToolBodyContext` define the cross-plane body signature: arguments in, value out, only a signal for cancellation. See `src/types.ts` for the full contracts.

## Model Experience

None, as this abstract seam registers no model-visible context; the tool registry (Consumer) owns any rendered effect once a provider is mounted.

#### KV Cache effect

No direct invalidation; this package does not contribute request tokens.

## Known Limitations and Deferred Work

- **No provider ships** — `'in-process'`/`'process'`/`'container'` are declared well-known `isolation` values; an `in-process` provider (the verification backend) and a `container` provider (the hard multi-tenant boundary) are separate packages.
- **`execute()` is one-shot** — the outcome arrives only on the resolved `ToolExecutionOutcome`; a streaming or persistent body has no progress API at the seam.
- **Bodies see only a signal** — a body that needs agent, session, or approval context cannot run behind this seam; such tools stay on the agent plane by design.
