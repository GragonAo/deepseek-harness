# @deepseek-ai/dsh-container-docker

English | [中文](README.zh.md)

Local Docker/Podman provider for the [`dsh-container`](../container) seam. It starts one *tool-exec* server container per (tenant, user) and runs commands inside it by posting over HTTP to that container's host-published loopback port (ip+host), bind-mounting three data layers: the case's shared directory read-write at `/shared`, the subject's case workspace read-write at `/workspace`, the subject's cross-case global directory read-write at `/global` (when a `usersRoot` is configured), and its tooling read-only at `/tools`. The container is started lazily on the subject's first tool call — a per-user container has no user to pre-warm at boot — under a stable, (tenant, user)-partitioned name. Different tenants and different users always land in different containers, so their processes and filesystems never share kernel context, and the container's own filesystem is discarded on reap — a tenant's or user's durable state is only its mounts.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-container-docker'
  config:
    runtime: 'docker'               # or 'podman'
    network: 'bridge'               # used unless the tenant sets network: 'none'
    toolExecImage: 'dsh-tool-exec:latest'  # in-container /exec server image
    toolExecPort: 8642              # container port that server binds
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip /global
    # idleTimeoutMs: 300000         # optional: reap a container this long after its last exec
```

## Container model

On a subject's first tool call inside a (tenant, user) scope the provider starts one tool-exec container for that scope. It first clears any same-name container (`docker rm -f`, a no-op when absent — a non-graceful host shutdown therefore cannot orphan one), then runs the tool-exec image detached under the stable, (tenant, user)-partitioned name:

```
docker rm -f dsh-<tenantPartition>-<userPartition>
docker run -d --name dsh-<tenantPartition>-<userPartition> \
  --network <network|none> -p 127.0.0.1::<toolExecPort> \
  -v <workspaceRoot>/users/<sub>:/workspace \
  -v <workspaceRoot>/shared:/shared \
  [-v <usersRoot>/<sub>:/global] [-v <toolsRoot>:/tools:ro] \
  <toolExecImage>
```

It then reads the published host port (`docker port`), waits for the container's `/exec` server to answer (bounded, so no exec races the in-container Node bind), and posts each exec to `http://127.0.0.1:<port>/exec` — the agent plane never runs `docker exec`. Concurrent first calls for the same scope join one in-flight start, so each (tenant, user) pays the cold-start at most once per process. The runtime image is `toolExecImage`; a tenant record carries no image. When `idleTimeoutMs` is set, an idle container is `docker rm -f`'d and lazily restarted on the next exec.

The tool-exec image ships the zero-dependency `/exec` server (`src/tool-exec.ts`) on Debian-slim + Node so the filesystem adapter's `stat`/`find`/`base64`/`test`/`command -v` coreutils semantics hold. Build it from the repository root:

```sh
docker build -f packages/tenant/container-docker/docker/Dockerfile \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t dsh-tool-exec:latest .
```

## Model Experience

### Tenant- and user-scoped container execution

#### What the model sees

Nothing. `ctx.containerRuntime` serves the filesystem and subprocess adapters below the model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **One container per (tenant, user) per Docker host.** The stable name pins each subject to a single named container, so two `dsh` processes on the same host that start in overlapping succession evict or re-create each other's same-name container (the second `rm -f` stops the first's, then starts its own); the container is stateless, so this degrades to a re-warm, but a shared-host multi-replica deployment that must hand off mid-traffic would want adopt-or-create instead of clear-and-start.
- **`internal` networking is deployment-owned.** A tenant opting into egress without internet depends on an internal network the deployment creates; this provider only skips `none` for its configured name.
- **No image pull policy.** The container's `/exec` server is waited on after start, but the pull itself is deployment-owned; deployments should pre-pull the tool-exec image or use one that resolves at `run` time.