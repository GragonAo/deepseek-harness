# Agent Note: Record a sandbox's life, and give library caches a writable home

Status: implemented

English | [中文](2026-10-14-sandbox-diagnostics.zh.md)

> A sandbox died of a node-wide OOM and the host log had nothing to say about it: the provider created, adopted, replaced and reaped sandboxes without a single line, and the cluster that could have explained the death was gone by the time anyone looked.

## Problem

The Kubernetes provider owns the whole life of a sandbox pod — it creates one on the first command, adopts an existing one that matches the current spec, replaces one that has reached a terminal phase, and deletes terminal pods left by earlier host processes — and it did all of that silently. Neither provider's source contained a call to `ctx.logger` at all. The failure that motivated this was an OOM kill: the pod was `Failed`, the session's next command silently got a fresh sandbox, and the only record of what happened was in a cluster whose events expire. A host log that had named the pod, its phase and the bound it ran under would have ended the investigation immediately.

The same sandbox showed a second, smaller defect on every command that imported matplotlib: `mkdir -p failed for path /root/.config/matplotlib: [Errno 30] Read-only file system: '/root/.config'`. The container runs with a read-only root filesystem and `HOME=/root`, so a library that writes a cache at its default location cannot, degrades to a temporary directory, and prints a warning into the command's output. The warning is not the real cost — the real cost is that the model reads it as a failure of its own command.

## Decision

- The provider logs the four events that decide a sandbox's fate: the sandbox it created (with the image and the resource bound that applied, or `no resource limits`), the sandbox it adopted (with the phase it found), the sandbox it is about to replace (with the phase and the cluster's events for that pod), and the terminal pods it reaped in a given phase. All four are `info` except the replacement, which is a `warn`.
- The criteria for a line: it describes something that happens once per sandbox rather than once per command, and nothing else in the system records it. Command-level logging is deliberately absent — the sandbox already returns each command's own output and exit status.
- `MPLCONFIGDIR` defaults to `/tmp/matplotlib`, one of the writable paths the pod mounts, and an operator's `env` entry of the same name wins. The provider states a default only where a mounted path is the answer rather than the library's own convention.

## Alternatives considered

- **Log at `debug` so a production host stays quiet.** Rejected: a sandbox's death is not routine, and a host running at `info` would then lose exactly the events this exists for.
- **Log every command the provider runs in a sandbox.** Rejected: the sandbox returns the command's own output, so those lines would repeat evidence the caller already holds, at the volume of the workload.
- **Mount a writable `/root/.config` so libraries can use their defaults.** Rejected: the read-only root is deliberate, and a second writable mount would make the sandbox's writable surface depend on which libraries happen to be installed.
- **Point `HOME` at `/tmp` instead.** Rejected: `HOME` also anchors `DSH_HOME`, and moving it changes where the harness's own state lands rather than where one cache lands.
- **Give every library a cache variable the same way.** Not taken: `MPLCONFIGDIR` answers a warning reproduced on every matplotlib import; no other library in the image was observed failing this way.

## Consequences

- The log is now the only record of a sandbox that outlives the cluster's events, so it is what an operator reads first when a session's work disappears.
- The replacement line carries the memory bound from the create line, which is enough to tell an OOM kill from an eviction without going back to the cluster.
- `MPLCONFIGDIR` covers matplotlib only. Another library that writes a cache at its default location still warns; each is a separate decision with its own evidence.
- The docker provider still logs nothing, so the two backends differ in observability. That difference is recorded as deferred work in its README.

### Verification

- `packages/tenant/container-k8s/tests/runtime.spec.ts` captures `ctx.logger` and asserts each line's format and arguments: creation with `limits {"memory":"6Gi"}`, creation without a bound as `no resource limits`, adoption with the phase, replacement with the phase and the cluster event behind it (`; events: Warning OOMKilling: Memory cgroup out of memory`) as well as without events, and the reaped pod names read out of `kubectl`'s own output.
- The same file pins `MPLCONFIGDIR`: unset, the pod's environment carries `/tmp/matplotlib`; with `env: {MPLCONFIGDIR: '/opt/cache'}` it carries the operator's value.
- The 68 tests of the container-k8s package pass and `pnpm run typecheck` is clean.
- On the acceptance cluster the read-only root is real: `touch /probe_ro` fails with `EROFS`, `HOME` is `/root`, and every matplotlib import printed the `/root/.config` warning above before this change.