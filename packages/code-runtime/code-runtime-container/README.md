# @deepseek-ai/dsh-code-runtime-container

English | [中文](README.zh.md)

Container implementation of the code-execution seam (`ctx.codeRuntime`). It runs each `run_code` program inside the ambient tenant's container — reached through `ctx.containerRuntime` — instead of a host worker thread, and bridges the program's declared bindings over a short-lived, token-authenticated HTTP surface that exposes only that request's bindings.

## Isolation model

The tenant container is the security boundary, not JavaScript. The program runs as `node --input-type=module -e <bootstrap>` inside the container, which holds only the tenant's bind-mounted `/workspace` and `/tools`. Even if the program escapes the program wrapper (its global `console`/`process.stdout`/`process.stderr` are patched into captured logs, but a resourced adversary could still reach richer Node APIs), it still has no host filesystem, environment, or secrets: isolation comes from the container. Binding calls — the only host access the program is offered — bridge over HTTP to a per-run server that resolves them by own-property lookup against the request's namespaces and returns lossless JSON or a program-side rejection.

The host bridge binds an ephemeral port on all interfaces and carries a per-run 256-bit token in its URL path, so only the run holding the URL can dispatch a binding. The `container-docker` provider publishes `--add-host host.docker.internal:host-gateway` so the container reaches the host gateway by that name; a Podman deployment points `config.hostBridge` at `host.containers.internal`.

## Program environment

The container exec carries only the sandbox's own facts: the environment the sandbox container was started with (the platform's identity variables), `DSH_CODE_BRIDGE` — this backend's per-run bridge URL — and the managed `DSH_*` group (`DSH_HOME`, `DSH_SHELL`, and `DSH_SESSION_ID` inside an agent's driver chain) composed by its sole owner, [`ctx.shellEnv`](../../shell/shell-env/README.md), through `collectSession()`. A `run_code` program therefore reads the same managed variables a `bash` call in that sandbox receives, and this runtime keeps no variable list of its own. The host's environment is never passed: the runtime reads `ctx.get('shellEnv')`, so a composition without the shell-env registry injects no managed group at all.

The session variable comes from the ambient agent-initiator scope — the agent loop's authority for the current driver chain — never from the process environment, `DSH_*` inherited from the sandbox, or the request: `CodeRunRequest` carries no session. It is absent when no initiator boundary is active or once the agent service is disposed.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `maxWallMs` | `600000` | wall-clock ceiling; crossing it aborts the exec and reports `timeout` |
| `maxOutputBytes` | `67108864` | hard cap on the serialized logs-plus-result payload, enforced in the container |
| `hostBridge` | `host.docker.internal` | hostname the container uses to reach the host bridge |

## Model Experience

Indirectly, through Code Mode in [`dsh-tools`](../../core/tools/README.md), which renders this backend's exact completion value when it fits (or an explicit `invalid-output` / `output-limit` failure) into a retained `run_code` tool result while binding traffic and intermediate values remain execution-local.

#### KV Cache effect

The retained `run_code` result appends to the parent request and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- Abort is best-effort: the container exec surface is one-shot, so aborting stops the host from waiting but does not hard-kill the in-container process (it is reaped with the idle container), and logs emitted after the abort are lost — unlike the worker-thread backend, which streams each log as it lands and terminates the worker.
- The wall-clock budget is the only time budget: the container cannot meter the program's event-loop busy time the way the worker thread's `computeMs` does.
- Captured stdout/stderr are bounded by the in-container budget, and the container exec runner bounds the raw stream it captures too, per stream, keeping the tail and reporting the truncation; what stays outside both is output that never reaches those pipes — a program that reopens the container's own stdout writes into the container log the runtime collects, which the `run_code` result cannot show.
- The managed group above is the built-in group only: contributor-owned variables such as `DSH_SESSION_JSONL` resolve from a shell tool execution, which a `run_code` call does not hold, so a program never receives them.