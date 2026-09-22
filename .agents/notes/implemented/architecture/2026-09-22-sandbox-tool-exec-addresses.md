# Agent Note: The tool-exec sandbox's published and dialled host addresses are configurable

Status: implemented

## Problem

Every (tenant, user) scope runs its tool calls in its own `dsh-tool-exec` container, started by the harness over the Docker socket. The provider published that container's HTTP port with `-p 127.0.0.1::<port>` and dialled it at `http://127.0.0.1:<port>`, both literals in the provider. That pair only holds when the harness shares the host's network namespace, which is why the multi-tenant deployment ran `network_mode: host`. A deployment that runs the harness in its own container on a bridge network cannot use it at all: inside that container `127.0.0.1` is the harness itself, so no sandbox is reachable and the published port sits where only the host can see it. Changing that was a source edit, not a deployment edit.

## Decision

`Config` gains two string fields, both defaulting to `127.0.0.1`:

- `publishHost` — the host address `docker run -p` binds the tool-exec port to.
- `connectHost` — the host address the provider dials for that published port.

`startContainer` publishes `${publishHost}::${toolExecPort}`, and `exec` and the readiness poll share one `toolExecBaseUrl(port)` built from `connectHost`.

A bridge-mode deployment sets `publishHost` to the bridge gateway address and `connectHost` to the gateway name (`host.docker.internal`, which the provider already adds to the sandbox with `--add-host`). Both defaults leave the host-network deployment unchanged.

## Alternatives considered

- **One field for both addresses**: rejected. The two differ in the container case — the port is published on the gateway address and dialled by the gateway name.
- **Detect the mode at runtime**: rejected. Nothing in the provider can tell whether its own process shares the host's network namespace, so a guess would mis-publish silently.
- **Publish on `0.0.0.0` by default**: rejected. The `/exec` server authenticates nothing, so an all-interfaces publication exposes unauthenticated command execution to the surrounding network; the field lets a deployment widen to the gateway address instead.
- **Spawn sandboxes on a shared Docker network and address them by DNS**: rejected as a larger change — it would replace the published-port contract the readiness poll and `docker port` read depend on.

## Consequences

- A deployment that runs the harness in a container reaches its sandboxes over the Docker gateway, and edits `publishHost` / `connectHost` in its profile instead of the provider source.
- `publishHost` widens what can reach an unauthenticated command surface: the gateway address keeps that surface on the host's Docker networks, while `0.0.0.0` does not.
- Cross-links: the container model and lifecycle come from [container-docker pre-warm](2026-08-26-container-docker-prewarm.md) and [sandbox resource ceilings](2026-09-22-sandbox-resource-ceilings.md).
