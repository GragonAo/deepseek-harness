# Agent Note: Sandbox and delegation waits carry deadlines

Status: implemented

English | [中文](2026-09-23-sandbox-operation-deadlines.zh.md)

## Problem

In the multi-tenant deployment a foreground delegation hung the parent session permanently: the event count froze, no tool result or turn end arrived, and no error was reported; only a host restart recovered it. The chain had no deadline anywhere, and one link cached the failure.

`container-docker` resolved the (tenant, user) runtime with `await this.ensure(...)` before looking at the caller's signal, so the `signal.aborted` check below it never ran and an already-aborted call still started a container. `ensure()` cached the start promise in a map and deleted the entry only when that promise settled, so a single start that never settled bricked that (tenant, user) key for the life of the process — every later tool call for that subject joined the same pending promise. No container CLI invocation, no whole start, and no tool-exec round trip carried a deadline: `runCli` resolved only on the child's `close`, its SIGKILL-on-abort listener was registered only when a signal was passed, and none ever was. The tool-exec `fetch` passed `signal: null`, which is an explicit statement that the request has no deadline.

Nothing downstream could compensate. The shell's own 120 s deadline reaches only the `fetch` that was never issued, because the provider was still inside `ensure`. On the return chain, the in-process driver awaited `child.whenIdle()` with no bound, and `tool-subagent` declared no `timeoutMs`, so [`guard/timeout-policy`](2026-07-07-tool-call-timeout-policy.md) installed no `TOOL_TIMEOUT` for the call at all.

## Decision

Three layers now end a wait the layer below cannot.

`container-docker` `Config` gains `cliTimeoutMs` (default `60000`), `startTimeoutMs` (default `180000`), and `transportTimeoutMs` (default `600000`), and the readiness wait's hardcoded constants become `readyTimeoutMs` (default `10000`) and `readyPollMs` (default `30`). Every container CLI invocation, the whole cold start, and the tool-exec round trip run under [`deadline`](../../../../packages/util/timeout/README.md) from `dsh-timeout`; `runner.ts` is unchanged, because passing a signal is what its existing kill-on-abort path needed.

A start that exceeds `startTimeoutMs` clears its `starting` entry and discards the runtime before throwing. This is the incident's fix: a failed start must never stay cached. `exec()` also brings `await ensure(...)` inside the caller's fused deadline, so an aborted or expired call stops waiting on a start in flight instead of joining it; the start itself continues for whoever else shares the key.

A tool-exec round trip that exceeds its bound is not retried. The existing replacement rule assumes a rejection means the command never ran — true for a transport or protocol failure, false for a timeout, where the command may still be executing inside the container.

`subagent-in-process-driver` gains `Config` with `settleTimeoutMs` (default `3600000`), which both in-process providers expose on their own config. `whenIdle()` is not cancellable, so the driver races it against the deadline; on expiry it cancels the child and settles the run as `aborted` with a diagnostic naming the bound, so `result` and the `dispose()` awaiting it always settle. That deadline carries no upstream signal: caller cancellation already reaches the child through the run's own abort listener, so only the driver's own expiry means the child stopped responding.

`tool-subagent` gains `foregroundTimeoutMs`, written as the tool definition's `timeoutMs`. Declaring a budget is what makes the timeout policy install `TOOL_TIMEOUT`; the field has no schema default, so a deployment that omits it keeps today's unbounded call.

## Alternatives considered

- **Give the caller's signal to every CLI call and rely on cancellation alone**: rejected. Nothing cancels a caller that is itself wedged, and the reported hang had no canceller at all.
- **Reject the start promise on expiry while leaving the cache entry**: rejected. The cached promise is exactly what bricks the (tenant, user) key.
- **Race the transport round trip against the deadline instead of forwarding the signal**: rejected. `fetch` already honors a signal, and racing would preempt the transport error the caller reports today.
- **Bound the child loop rather than the wait for it**: rejected. The driver does not own the agent loop; cancelling the child is the operation it does own.
- **A hardcoded deadline inside each plugin**: rejected by the no-hardcoded-tunables rule — how long a host's container daemon or a delegation may take is deployment-varying, so each is a validated `Config` field.

## Consequences

- The multi-tenant deployment sets `cliTimeoutMs: 60000`, `startTimeoutMs: 180000`, `transportTimeoutMs: 600000`, `readyTimeoutMs: 10000`, and `readyPollMs: 30` on `container-runtime`, and `foregroundTimeoutMs: 1800000` on both `tool-subagent` instances. `transportTimeoutMs` covers the command's own execution inside the container, so it stays above the model-facing deadlines (shell 120 s, delegation 30 min) that end a call earlier.
- A wedged container daemon now costs one failed tool call and a fresh start on the next one, instead of stopping every tool call for that subject until the host restarts.
- A start that fails after `docker run -d` still leaves a container under the stable name until the next start clears it; this matches the pre-existing behaviour on any failed start, and the next start's `rm -f` is what removes it.
- Cross-links: the replacement rule this change keeps is [sandbox replacement on exec failure](2026-09-22-sandbox-replacement-on-exec-failure.md); the deadline primitive and the policy that consumes a declared `timeoutMs` are [the timeout deadline library](2026-07-06-timeout-deadline-library.md) and [the tool-call timeout policy](2026-07-07-tool-call-timeout-policy.md).

### Verification

- `packages/tenant/container-docker/tests/docker.spec.ts` adds five cases: a CLI call that never returns fails within `cliTimeoutMs`; a wedged start fails within `startTimeoutMs` and the next `exec` invokes the CLI again (the cached-promise gate); a tool-exec round trip that never answers fails within `transportTimeoutMs`; an already-aborted call starts nothing; an abort during a pending start escapes it. 19 tests green.
- `packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts` asserts a `'hang'` child under `settleTimeoutMs: 50` settles as `aborted` with the bound in its diagnostic and still disposes. 59 tests green across the package.
- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` asserts the registered tool's `timeoutMs` equals the configured `foregroundTimeoutMs`, and is undefined when none is configured. 73 tests green across the package.
