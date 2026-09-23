# Agent Note: A failed tool-exec transport replaces the sandbox and replays the request

Status: implemented

English | [中文](2026-09-22-sandbox-replacement-on-exec-failure.zh.md)

## Problem

`DockerContainerRuntime` caches sandboxes by (tenant, user): `ensure` returns a cache hit as-is, and `exec` takes its address and sends the request without checking whether the sandbox is alive.

Nothing guarantees a sandbox survives: a host process restart, an operator's `docker rm`, the subject being OOM-killed, or an external cleanup script all turn the cached address into a dead one. Every tool call for that subject then fails until the host itself restarts — `fs-container` reads and writes, `bash` execution, and `glob` all go through the same `runtime.exec`, so the whole sandbox capability fails together.

Measured: after the sandbox container was deleted, every read of `/shared` and `/workspace` and every bash call in the session reported `fetch failed` for the rest of the session, and the model could only report to the user that the sandbox execution / filesystem backend was currently unavailable. For a non-technical user that is a dead end — nothing tells them to restart the host container.

## Decision

`exec` self-heals on a transport failure: it discards the cached sandbox (`discard`), calls `ensure` to start one again, and sends the same request a second time. Only a second failure reaches the caller.

The discriminator is what `client.exec` rejects on: it rejects only on a transport or protocol failure — a command's own exit code travels in the result (`exitCode`), not as an exception. Any error thrown by `exec` therefore means the sandbox may be gone, and replaying is safe: the container no longer exists, so the command cannot already have run. Two cases do not replay. A caller-initiated abort (`opts.signal.aborted`) is the user cancelling, not a failure. An expired `transportTimeoutMs` is not a transport failure either — the command may still be running inside the container, so replaying it would repeat its side effects; the discard still happens, so the next call lands on a fresh sandbox.

The former `reap` (idle collection) is renamed `discard`: the idle timeout and a failed exec take the same "throw the sandbox away" path, and the old name described only the first.

## Alternatives considered

- **Surface the unreachable-container error to the caller**: rejected. The subject cannot act on it — the measured failure was every later tool call failing the same way, with the model reporting an unavailable backend until the host was restarted.
- **Replay more than once**: rejected. A persistent cause (the image is gone, the host is out of memory) would make every tool call pay repeated cold starts instead of failing loud; one replay separates a dead address from a broken deployment.
- **Keep `reap` as the name of the shared path**: rejected. The idle timeout and a transport failure are different triggers for one action, and a name describing only the timer hides that the failure path exists.

## Consequences

- A sandbox failure is invisible to the user: the next tool call succeeds in a new sandbox.
- A command may run twice at the "container died mid-command" boundary. The sandbox's `/workspace` and `/shared` are bind mounts, so replaying is meaningful there; that is more acceptable than leaving the session permanently stuck.
- Concurrent calls that fail together each trigger a replacement, and `ensure`'s `starting` table keeps that to one container.
