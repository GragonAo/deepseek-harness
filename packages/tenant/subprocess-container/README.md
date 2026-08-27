# @deepseek-ai/dsh-subprocess-container

English | [中文](README.zh.md)

Container provider for the [`dsh-subprocess`](../../subprocess/subprocess) capability seam. `resolveExecutable` and `spawn` run against the ambient tenant's container — the same execution world the filesystem provider serves — so a tool's process never leaves the tenant's isolation boundary.

## Configuration

None. It injects `containerRuntime` and delegates every executable and process to the shared owner (e.g. [`dsh-container-docker`](../container-docker)), whose mounted `/workspace` and `/tools` become the process world.

## Model Experience

### Subprocess execution in the tenant container

#### What the model sees

Nothing. The provider serves the `ctx.subprocess` shell and tool consumers below the model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **Captured-exec, not streaming.** `spawn` runs each command to completion and settles `done` and the collect readers afterwards; piped (`'pipe'`) stdio and live mid-flight reads are not supported in this slice. `terminate()` is a no-op because there is no live tree to signal.
- **`pid` is `-1`.** The captured exec does not expose the container's process id.
- **`resolveExecutable` ignores the `env` lookup parameter** — lookups use the container's ambient `PATH`.
- **No terminal primitive.** `spawnTerminal` rejects; the PTY/terminal consumer is out of the vertical slice's scope.