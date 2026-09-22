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
      publishHost: '127.0.0.1'        # host address that port is published on
      connectHost: '127.0.0.1'        # host address the harness dials for it
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip /global
systemRoot: '/root/.dsh/system' # host system skill tree; mounted read-only at the same path
    # idleTimeoutMs: 300000         # optional: reap a container this long after its last exec
    # memoryLimit: '2g'             # optional: hard memory ceiling; swap is capped at the same value
    # cpuLimit: 2                   # optional: CPU ceiling in whole cores
```

## Container model

On a subject's first tool call inside a (tenant, user) scope the provider starts one tool-exec container for that scope. It first clears any same-name container (`docker rm -f`, a no-op when absent — a non-graceful host shutdown therefore cannot orphan one), then runs the tool-exec image detached under the stable, (tenant, user)-partitioned name:

```
docker rm -f dsh-<tenantPartition>-<userPartition>
docker run -d --name dsh-<tenantPartition>-<userPartition> \
  --network <network|none> -p <publishHost>::<toolExecPort> \
  [--memory <memoryLimit> --memory-swap <memoryLimit>] [--cpus <cpuLimit>] \
  -v <workspaceRoot>/users/<sub>:/workspace \
  -v <workspaceRoot>/shared:/shared \
  [-v <usersRoot>/<sub>:/global] [-v <toolsRoot>:/tools:ro] \
[-v <systemRoot>:<systemRoot>:ro] \
  <toolExecImage>
```

It then reads the published host port (`docker port`), waits for the container's `/exec` server to answer (bounded, so no exec races the in-container Node bind), and posts each exec to `http://<connectHost>:<port>/exec` — the agent plane never runs `docker exec`. Concurrent first calls for the same scope join one in-flight start, so each (tenant, user) pays the cold-start at most once per process. The runtime image is `toolExecImage`; a tenant record carries no image. When `idleTimeoutMs` is set, an idle container is `docker rm -f`'d and lazily restarted on the next exec. `memoryLimit` and `cpuLimit` are ceilings, not reservations: an idle container costs only what its own process uses, and only a subject that exceeds its ceiling is stopped — memory over the limit OOM-kills the process inside its own container (exit 137), and CPU is capped as a share of a core, so idle subjects never hold a core back from others.

`systemRoot` is mounted at its own absolute path, not at a fixed in-container location: a skill's instructions cite companion files (templates, methodology, verification scripts) relative to the directory the skill was discovered in, so the path the host resolved must be the path the sandbox sees. It is read-only, and omitting it leaves the system skill tree host-only — skill bodies still reach the model through the host-side skill provider, but the files they cite are unreadable inside the sandbox. The case-shared and per-subject trees need no such setting: they are already mounted at `/shared` and `/global`.

A sandbox has no guaranteed lifetime — the host may restart, an operator may remove the container, the subject may be OOM-killed — so a cached address can go dead under a live session. When `exec` rejects (a command's own exit status travels in the result, so a rejection means transport or protocol failure), the runtime discards that sandbox, starts a replacement, and runs the same request once against it; only a second failure reaches the caller. Both execution and the `/workspace` filesystem provider go through this one path, so a replaced sandbox restores both. An exec the caller aborted is never retried.

`publishHost` and `connectHost` default to the host loopback, which assumes the harness shares the host's network namespace. A harness running in its own container reaches the published port over the Docker gateway instead: set `connectHost: host.docker.internal` and widen `publishHost` to the bridge gateway address (e.g. `172.17.0.1`). Prefer that gateway address over `0.0.0.0` — the `/exec` server authenticates nothing, so an all-interfaces publication exposes unauthenticated command execution to the surrounding network.

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
- **No disk ceiling.** Only memory and CPU are capped. A subject's writes land in its bind-mounted `/workspace`, `/shared`, and `/global` directories, which the host owns, so a storage quota needs a filesystem or volume-level mechanism this provider does not apply.