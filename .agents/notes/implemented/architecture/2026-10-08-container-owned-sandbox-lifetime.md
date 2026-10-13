# Agent Note: A sandbox decides its own lifetime

Status: implemented

English | [中文](2026-10-08-container-owned-sandbox-lifetime.zh.md)

## Problem

A sandbox Pod has no controller, so whatever creates it also decides when it ends. Until this change the host decided, from a timer per (tenant, user) inside the host process: `container-docker` and `container-k8s` each held an idle timer and deleted the container or Pod when it fired. A host only sees its own cached handle, while every request reaches the container, so with two host replicas the idle one deletes the sandbox the busy one is using: the busy request fails and its tenant pays a cold start it did not cause.

The same timers left a second failure class behind. `ensureSandbox` adopts a `Running` or `Pending` Pod, so a Pod that can never become ready — a `subPath` mount the kubelet cannot finish, for example — was adopted again by every retry and never deleted: the host-side reap only ran for a handle it had cached, and a failed start caches nothing. That (tenant, user) stayed blocked for good, and a bare Pod has nobody else to collect it.

## Decision

The sandbox owns its death. `idleTimeoutMs` is injected into the sandbox as `DSH_TOOL_EXEC_IDLE_MS` — Pod `env` in k8s, `-e` in docker — and the in-container tool-exec server exits once no request has arrived for that long and nothing is executing. Whether a subject is being used is a fact only the container can observe, so this decision needs no registry, no database table, and no coordination between replicas: a host stays stateless, and every replica may serve any subject.

An in-flight request is not idleness, so the check also counts requests still executing. A command longer than the budget therefore never interrupts itself, and the clock restarts when the command ends rather than when it started.

The host keeps only what its own process can know. It caches a handle for `sandboxCacheTtlMs` (`sandboxCacheTtlMs: 0` never trusts a handle); a sandbox that exited underneath a live handle costs one failed exec, which the retry path rebuilds from. Each provider also deletes what it cannot use: a start that never becomes ready within `startTimeoutMs`, or a sandbox whose tool-exec server never answers within `readyTimeoutMs`, is deleted before the failure is reported, so the next use starts clean instead of adopting the same broken Pod. At startup each provider collects the terminal sandboxes it owns (`Succeeded`, `Failed`) by managed label and phase selector, and never a `Running` or `Pending` one, which may be another replica's live sandbox.

## Alternatives considered

- **Delete from the host on a timer** (before this change): rejects — a host sees its own cache, not the subject's use, so a second replica deletes a sandbox in use.
- **Record last use in the database and sweep from it**: rejects — a derived view that can drift from the sandbox, a write on the hot path of every tool call, and the sweep still cannot tell an abandoned live sandbox from a busy one.
- **Create each sandbox as a Job with `ttlSecondsAfterFinished`**: deferred — the cluster would then own collection entirely, but a sandbox has to keep a stable name to be adopted across replicas and a Job generates its Pod name; today's label sweep collects the same residue without a controller.

## Consequences

- A replica never deletes another replica's live sandbox, so several hosts may serve one tenant without a leader, a lease, or shared state. This is what lets the management plane stay stateless.
- `idleTimeoutMs` no longer reclaims anything in the host process: a sandbox exits itself, so its next use cold-starts. The budget still means "how long a sandbox may stay parked", but its enforcement now travels with the sandbox.
- A terminal sandbox remains in the cluster until the next startup sweep, and a `Running` sandbox whose (tenant, user) is never used again remains until an operator deletes it by label. Deleting live Pods at startup would reintroduce the cross-replica deletion this change removes.
- The image must read `DSH_TOOL_EXEC_IDLE_MS`. An image that ignores it leaves idle sandboxes running, which is the previous behavior rather than a broken sandbox; the container's own exit leaves a `Succeeded` Pod because `restartPolicy` is `Never`.
- The host's per-scope idle timers are gone from both providers; the `container-docker` teardown no longer iterates them.

### Verification

- `packages/tenant/container-docker/tests/tool-exec.spec.ts` covers the watchdog against a real listening server with an injected exit channel and clock: it exits once the budget passes with nothing in flight, never exits when no budget is configured, keeps a 250ms command alive past a 30ms budget and exits only after it ends, and pushes the deadline back when a request arrives. 7 of 10 tests in that file pass; the three that POST `sh -c` fail on the Windows development host, which has no `sh` on the spawned process `PATH` (`spawn sh -> ENOENT`), and they are unrelated to this change.
- `packages/tenant/container-k8s/tests/runtime.spec.ts` asserts that the budget reaches the Pod environment and that an unset budget injects no variable; that a Pod which never becomes ready is deleted (the cluster's only Pod is gone, and the next exec creates a second); and that startup sweeps `Succeeded` then `Failed` Pods by managed label and phase selector. 23 of 23 pass.
- `packages/tenant/container-docker/tests/docker.spec.ts` asserts the budget reaches the container as an environment variable and that startup sweeps exited, managed containers. 33 of 33 pass.
- `pnpm exec tsc -b tsconfig.host.json` is clean.
- Live on the deployment host (`192.168.138.130`, namespace `dsh`, with `idleTimeoutMs` temporarily lowered to `60000`): a real agent turn produced a sandbox Pod whose environment carried `DSH_TOOL_EXEC_IDLE_MS: "60000"`, and that Pod's tool call completed (`tool/call` → `tool/result` in 0.03s). 100 seconds after its last request the Pod was `Succeeded` with container exit code `0` (`Completed`) — the watchdog's path, since a signalled Node process exits `143` instead. A host restart at that point reported no managed Pods at all: the startup sweep deleted the terminal Pod, on a host that had one and nothing else to remove it. The budget was then restored to `900000` and the host restarted.
