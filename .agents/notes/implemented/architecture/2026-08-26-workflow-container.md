# Agent Note: Container workflow via a MessagePort↔HTTP duplex adapter

Status: implemented

English | [中文](2026-08-26-workflow-container.zh.md)

## Problem

The multi-tenant hardening requires that orchestration scripts the model writes run off the agent host. `workflow-worker-thread` runs them in a host worker thread, where an escaped script can read host files, environment, or secrets. The container world already isolates bash/fs/subprocess/code tools; workflow was the last host-side execution surface.

## Decision

Ship `@deepseek-ai/dsh-workflow-container`, a `WorkflowEngine` provider that reuses the whole worker-side runtime and swaps only its transport. Concretely:

- The worker-side runtime (`runWorkerSession` in `workflow-worker-thread/src/session.ts`, plus `runtime.ts`/`realm.ts`/`meta.ts`) is transport-agnostic over a `MessagePort` and is in-process tested; it is not rewritten.
- A container entry (the bundled worker fed through stdin as `node --input-type=module -`, since the bundle exceeds Linux's per-argument ceiling that `-e` would carry it as) constructs a `MessagePort`-shaped adapter over HTTP — `postMessage` POSTs the worker→host message to the host bridge, `on('message')` long-polls the host bridge for host→worker messages (Go/Cancel/ChildStarted/ChildStartError/ChildSettled/ChildFailed/ChildDisposed) and dispatches them — then reads the init payload from the `DSH_WORKFLOW_INIT` env var (the run payload cannot share stdin with the bundle) and calls `runWorkerSession(adapter, init)`.
- The host side runs the run inside the tenant container via `ctx.containerRuntime.exec` and stands up a per-run token-authenticated duplex bridge (the same ephemeral-port + URL-token shape as `code-runtime-container`'s binding bridge): one endpoint receives worker POSTs (phase/log/ agent-start/agent-end + the child-start/dispose RPCs), a second endpoint serves the worker's long-poll with queued host→worker messages. Child RPC lands on the existing subagent seam (`ctx.subagents.start`), exactly as the worker-thread host already does.
- The container-side worker runtime and the HTTP adapter are bundled into a self-contained worker module (read once at run time and fed through stdin, the init through `DSH_WORKFLOW_INIT`); the host threads a `hostBridge` config field (default `host.docker.internal`) so the container reaches the host gateway by name.
- The shared wire protocol and `renderThrown`/`ExecutionObserver` move onto `workflow-worker-thread`'s public export (the container provider is their second consumer).

## Alternatives considered

- Hand-roll a second, container-specific workflow runtime: rejected — it duplicates roughly two thousand lines of concurrency/caps/cancellation/combinator logic for no isolation gain beyond the transport.
- Bridge the child RPC and events but keep the script's combinators host-side: rejected — the script body itself (user/mkdir/loops between `agent()` calls) is the code that must stay off the host.
- WebSocket instead of long-poll: rejected — long-poll over two plain HTTP endpoints needs no new dependency and matches the code-runtime bridge's short-lived token shape.

## Consequences

- `workflow-container` provides `ctx.workflowEngine`; `tool-workflow`/`tool-ralph` consume it unchanged, so a tenant keeps the single-user workflow surface with in-container execution.
- The multi-tenant bundle mounts `workflow-container` and re-enables the two tools (web-app already disables the host `workflow-worker-thread` row); the host worker-thread engine stays off in the multi-tenant profile.
- The duplex bridge is the new attack surface; it is per-run token-authenticated, ephemeral, and holds a bounded host→worker queue drained by the worker's long-poll.
- Three documented gaps versus the worker-thread provider (see the package README): the bundled worker and its init avoid Linux's per-argument/env ceiling by riding stdin plus one env var (both would move to container temp files if they outgrew those ceilings), abort is best-effort on the one-shot exec surface, and long-poll adds a round-trip per host→worker message.

### Verification

- `packages/workflow/workflow-container/tests/runtime.spec.ts` runs the real bundled worker in a local `node` subprocess against the real in-process duplex bridge (`hostBridge: '127.0.0.1'`), covering the full wire exchange (`ready`/`phase`/`log`/`result`) and the completed value.
- `packages/workflow/workflow-container/tests/built-engine.e2e.ts` boots the built engine under plain Node and drives a real `agent()` round-trip (a bridged child returning a structured value) to a `completed` result, plus `dispose()`.
- `packages/bundle/multi-tenant/tests/multi-tenant.spec.ts` asserts the mount of `workflow-container` and the re-enable of `tool-workflow`/`tool-ralph` while the host `workflow-worker-thread` row stays disabled. `verify-cordis-config`, build, and the runtime-closure gate pass.