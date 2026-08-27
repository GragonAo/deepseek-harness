# @deepseek-ai/dsh-workflow-container

English | [中文](README.zh.md)

Container implementation of the workflow seam (`ctx.workflowEngine`). It runs each workflow's model-written orchestration script inside the ambient tenant's container — reached through `ctx.containerRuntime` — instead of a host worker thread, and bridges the script's `agent()` calls back to `ctx.subagents` over a per-run, token-authenticated HTTP duplex. It reuses the worker-thread engine's entire worker-side runtime unchanged; only the transport differs.

## Isolation model

The tenant container is the security boundary, not JavaScript. The provider feeds the bundled worker to `node --input-type=module -` inside the container (`DSH_WORKFLOW_INIT` carries the run's init payload — the bundle itself cannot ride `-e` because it exceeds Linux's per-argument ceiling), so the script — including the top-level code between `agent()` calls — runs where only the tenant's bind-mounted `/workspace` and `/tools` exist. `agent()` calls are the only host access the script is offered, and they bridge over HTTP to a per-run server that resolves them through the existing subagent seam (`ctx.subagents.start`) with the same admission, cancellation, and child RPC the worker-thread host drives.

The host bridge binds an ephemeral port on all interfaces and carries a per-run 256-bit token in its URL path, so only the run holding the URL can dispatch an `agent()` call or drain the host-to-worker queue. The `container-docker` provider publishes `--add-host host.docker.internal:host-gateway` so the container reaches the host gateway by that name; a Podman deployment points `config.hostBridge` at `host.containers.internal`.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `provider` | `spawn` | the `ctx.subagents` provider children run on (per-run `subagentProvider` overrides) |
| `maxConcurrentAgents` | `0` | concurrent `agent()` ceiling; `0` auto-resolves to `min(16, max(1, cores - 2))` |
| `maxTotalAgents` | `1000` | total `agent()` calls one run may start — the runaway-loop backstop |
| `maxItemsPerCall` | `4096` | items accepted by a single `parallel()`/`pipeline()` call |
| `syncTimeoutMs` | `5000` | vm timeout for the script's initial synchronous slice, inside the container |
| `disposeGraceMs` | `5000` | grace after cancellation before `cancelled` force-settles and the process is aborted |
| `hostBridge` | `host.docker.internal` | hostname the container uses to reach the host bridge |

## Model Experience

### Child-agent requests

#### What the model sees

Every script `agent()` call sends its prompt verbatim and optional model or structured-output schema to a subagent provider. Each child sees that provider's own context; phase and log narration stays on observer events.

#### Token effect

Potentially many independent child contexts are paid, bounded by `maxConcurrentAgents`, `maxTotalAgents`, and `maxItemsPerCall`; they never join the parent history directly.

#### KV Cache effect

Independent of the parent request cache and of sibling children. Each child can reuse only a byte-identical prefix under its own provider, model, prompt, and schema; its later history grows append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-workflow`, success exposes only the materialized final JSON value and child count in that consumer's wrapper. Intermediate child outputs are available to the script but not the parent model.

#### Token effect

Zero direct parent tokens from this engine. Final result size is capped by the tool consumer and retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- The bundled container worker is fed through stdin (`node --input-type=module -`) and its init through the `DSH_WORKFLOW_INIT` env var, because a single `-e` argv entry cannot exceed Linux's per-argument size ceiling; if the init payload ever grows past the env-var ceiling too, both must ship as container temp files instead.
- Abort is best-effort: the container exec surface is one-shot, so aborting stops the host from waiting but does not hard-kill the in-container process (it is reaped with the idle container), and worker messages in flight across the abort are dropped — unlike the worker-thread backend, which terminates the worker.
- Long-poll adds a round-trip per host-to-worker message (Go/Cancel/child RPC) versus the worker-thread's in-process channel; acceptable for observer events and `agent()` calls, not for hot loops inside the script.