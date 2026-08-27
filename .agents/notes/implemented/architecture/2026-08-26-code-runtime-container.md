# Agent Note: Container code-runtime runs model code off-host

Status: implemented

English | [中文](2026-08-26-code-runtime-container.zh.md)

## Problem

The multi-tenant hardening requires that code a model decides to run never execute on the agent host: the worker-thread `code-runtime` backend runs `run_code` programs in a host worker thread, where an escaped program can read host files, environment, or secrets. The container world already isolates bash/fs/subprocess tooling per tenant; code execution was the remaining host-side execution surface.

## Decision

Ship `@deepseek-ai/dsh-code-runtime-container`, a `CodeRuntime` backend (`isolation: 'container'`) that runs the type-stripped program as `node --input-type=module -e <bootstrap>` inside the ambient tenant's container via `ctx.containerRuntime.exec`, and bridges the program's declared bindings over a per-run HTTP surface. The isolation boundary is the container, not JavaScript: the in-container bootstrap patches `console`/`process.stdout`/`process.stderr` into ordered captured logs and frames one JSON result line on stdout, but even a program that escapes those shims still has no host state, because it only ever ran in the tenant container.

The host bridge is a short-lived `createBindingBridge` bound to an ephemeral port on all interfaces; its URL carries a per-run 256-bit token, and it resolves calls by own-property lookup against the request's namespaces (lossless-JSON arguments and results, program-side rejections on failure). `container-docker` publishes `--add-host host.docker.internal:host-gateway` so the container reaches the host gateway; a config field (`hostBridge`) names the host reachable from inside the container, defaulting to `host.docker.internal` (Podman users set `host.containers.internal`).

## Alternatives considered

- Reuse the worker-thread `bootstrap.ts` verbatim over a MessagePort: impossible — the container has no MessagePort to the host, only the one-shot `exec` surface and a reachable host address.
- Bridge bindings through a file mailbox under the bind-mounted `/workspace`: avoids the host gateway, but adds poll latency and a per-tenant scratch-dir protocol for no isolation gain.
- Keep the worker-thread backend and document the risk: rejected — it leaves host secrets reachable by model code, which is the exact exposure the hardening must close.
- Drive the whole run over the existing `POST /exec` server only: rejected — that surface is one-shot and cannot carry the program's outbound binding calls back to the host.

## Consequences

- Model-authored code no longer runs in the agent process; the rounding of `run_code` to the tenant container completes the "all AI-decided execution in the tool/container layer" requirement.
- The host bridge and its token are the only new attack surface; they are short-lived, ephemeral, and resolve only the in-flight request's bindings.
- Two documented gaps versus the worker-thread backend (see the package README): abort is best-effort (the one-shot exec surface has no hard kill, and post-abort logs are lost), and the wall-clock budget is the only time budget (no in-container busy-time metering).

### Verification

- `packages/code-runtime/code-runtime-container/tests/runtime.spec.ts` runs the real bootstrap in a local `node --input-type=module -e` subprocess against the real in-process bridge (`hostBridge: '127.0.0.1'`), covering: erasable-TypeScript execution with ordered capture; binding bridge both ways plus typed rejection; undeclared-member TypeError; thrown → `exception`; non-JSON completion → `invalid-output`; non-zero exit → `worker-exit`. 7 tests green.
- `packages/tenant/container-docker/tests/docker.spec.ts` asserts the `--add-host host.docker.internal:host-gateway` argument. `packages/bundle/multi-tenant/tests/multi-tenant.spec.ts` asserts the disable of the host `code-runtime` row and the mount of `code-runtime-container`.