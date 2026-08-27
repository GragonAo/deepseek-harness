# @deepseek-ai/dsh-container

English | [中文](README.zh.md)

Container-runtime Service Definition (`ctx.containerRuntime`): shared ownership of one tenant-scoped container execution world. Filesystem and subprocess adapters await the same runtime, so file and process operations inhabit one isolated Linux world per exposed tenant. The shipped provider is [`@deepseek-ai/dsh-container-docker`](../container-docker).

## Shape

- `ContainerCommandResult` — a completed command's `exitCode` plus captured `stdout`/`stderr`.
- `ContainerExecOptions` — optional stdin feed and cancellation.
- `ContainerRuntime` (`ctx.containerRuntime`) — the abstract Service Definition with one primitive: `exec(command, args?, opts?)`, which runs inside the ambient tenant's container (resolved per call from `requireTenant()`).

## Model Experience

### Container command execution

#### What the model sees

Nothing. The `ctx.containerRuntime` runtime serves the filesystem and subprocess providers below the model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **No explicit lifecycle primitive.** `exec` lazily materializes the tenant's container; teardown belongs to each provider's dispose effect (stopping every container it started).