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
    # PATH that image gives its commands; set it together with toolExecImage (default: the Debian base image's)
    # toolExecImagePath: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    toolExecPort: 8642              # container port that server binds
    publishHost: '127.0.0.1'        # host address that port is published on
    connectHost: '127.0.0.1'        # host address the harness dials for it
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip /global
    systemRoot: '/root/.dsh/system' # host system skill tree; mounted read-only at the same path
    pythonRoot: '/opt/.dsh/pyenv'   # host Python runtime (no Python in the image); mounted read-only at the same path
    # idleTimeoutMs: 300000         # optional: reap a container this long after its last exec
    # memoryLimit: '2g'             # optional: hard memory ceiling; swap is capped at the same value
    # cpuLimit: 2                   # optional: CPU ceiling in whole cores
    # cliTimeoutMs: 60000           # optional: bound on one docker/podman invocation
    # startTimeoutMs: 180000        # optional: bound on one whole cold start
    # transportTimeoutMs: 600000    # optional: bound on one tool-exec round trip
    # readyTimeoutMs: 10000         # optional: bound on the wait for /exec to answer
    # readyPollMs: 30               # optional: interval between readiness probes
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
  -v <workspaceRoot>/shared/skills:<workspaceRoot>/shared/skills:ro \
  [-v <systemRoot>:<systemRoot>:ro] \
  [-v <pythonRoot>:<pythonRoot>:ro] \
  [-e PATH=<pythonRoot>/bin:<toolExecImagePath>] [-e VIRTUAL_ENV=<pythonRoot>] \
  [-e PYTHONPATH=<pythonRoot>/lib/python3.<minor>/site-packages] \
  -e DSH_CASE_ID=<tenant id> -e DSH_TENANT_ID=<tenant id> -e DSH_USER_ID=<subject> \
  <toolExecImage>
```

It then reads the published host port (`docker port`), waits for the container's `/exec` server to answer (bounded, so no exec races the in-container Node bind), and posts each exec to `http://<connectHost>:<port>/exec` — the agent plane never runs `docker exec`. Concurrent first calls for the same scope join one in-flight start, so each (tenant, user) pays the cold-start at most once per process. The runtime image is `toolExecImage`; a tenant record carries no image. When `idleTimeoutMs` is set, an idle container is `docker rm -f`'d and lazily restarted on the next exec. `memoryLimit` and `cpuLimit` are ceilings, not reservations: an idle container costs only what its own process uses, and only a subject that exceeds its ceiling is stopped — memory over the limit OOM-kills the process inside its own container (exit 137), and CPU is capped as a share of a core, so idle subjects never hold a core back from others.

`systemRoot` is mounted at its own absolute path, not at a fixed in-container location: a skill's instructions cite companion files (templates, methodology, verification scripts) relative to the directory the skill was discovered in, so the path the host resolved must be the path the sandbox sees. It is read-only, and omitting it leaves the system skill tree host-only — skill bodies still reach the model through the host-side skill provider, but the files they cite are unreadable inside the sandbox. The per-subject tree needs no such setting: it is already mounted at `/global`. The case-shared tree is mounted at `/shared`, but its `skills` directory is additionally mounted read-only at its own host path, because the case-shared skill tier reports that path as a skill's base directory — a skill discovered there cites its companion files by a host path the sandbox must resolve.

`pythonRoot` names the one Python runtime every sandbox runs — interpreter, standard library, and installed packages in that single directory — mounted read-only at its own absolute path. The tool-exec image ships no interpreter, so this mount is the sandbox's only Python: `<pythonRoot>/bin` goes to the front of `PATH`, `<pythonRoot>/pyvenv.cfg` makes the directory `VIRTUAL_ENV`, and `<pythonRoot>/lib/python3.<minor>/site-packages` joins `PYTHONPATH`. One directory therefore fixes both the interpreter version and every dependency for every sandbox, which is what a no-internet deployment needs: an operator installs into it and the next sandbox has the package, with no image rebuild, no redistribution, and no version to keep in step with the image. Omitting the field mounts nothing and sets no Python variable, which leaves a sandbox with no `python3` at all — the mount is a hard requirement, not an optimization. A configured `pythonRoot` this process cannot read fails the load instead of degrading: the harness reads that directory itself before handing the path to the container runtime, so a path only the Docker daemon resolves — the usual cause being a host directory not mounted into the container the harness itself runs in — would otherwise mount an empty directory and configure nothing. A configured directory that holds none of the three markers is refused at load as well, and Docker creating a missing bind-mount source as an empty directory is exactly why: that empty directory is what a mount whose environment was never built looks like, and it would otherwise configure nothing. So the deployment does not depend on an operator remembering the order — an environment that was never built stops the host instead of starting sandboxes with no interpreter, and the two ways out are to install the environment at that path or to drop `pythonRoot`. A directory holding any one of the three markers is legal and configures that one alone.

A virtual environment is not self-contained, so it is not what belongs here: `python3 -m venv --copies` copies the interpreter executable, but that executable still loads its standard library from `/usr/lib/python3.<minor>/` and `libpython3.<minor>.so` of the system it was created on. With no Python in the image there is no such system, so the mounted directory has to be a relocatable build — a `python-build-standalone` `x86_64-unknown-linux-gnu` `install_only` tree, or a complete conda environment.

Prepare it where there is internet access and copy the directory in whole, since the internal host cannot fetch packages. Unpack a relocatable build (any 3.x `install_only` build for `x86_64-unknown-linux-gnu` unpacks as `./python`), install the case tooling into it with its own `pip` — run inside a container, since the tool-exec image has no Python to run that pip with — then copy the whole directory to the internal host at the path the sandbox mounts:

```sh
curl -LO https://github.com/astral-sh/python-build-standalone/releases/download/<release>/cpython-3.11.<patch>+<release>-x86_64-unknown-linux-gnu-install_only.tar.gz
tar -xzf cpython-3.11.*-x86_64-unknown-linux-gnu-install_only.tar.gz
mv python pyenv
docker run --rm -v "$PWD/pyenv:/pyenv" -e PATH=/pyenv/bin:/usr/bin:/bin \
  --entrypoint sh dsh-tool-exec:latest -c 'python3 -m pip install openpyxl xlrd pandas'
rsync -a pyenv/ <internal-host>:/opt/.dsh/pyenv/
```

After mounting, one command proves the sandbox sees it:

```sh
docker run --rm -v /opt/.dsh/pyenv:/opt/.dsh/pyenv:ro \
  -e PATH=/opt/.dsh/pyenv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --entrypoint sh dsh-tool-exec:latest -c 'python3 -c "import openpyxl, pandas, platform; print(platform.python_version())"'
```

The one version constraint is on the build rather than on the extensions: the mounted Python must run on the image's glibc — the image is Debian 12 (glibc 2.36), and a build made for a newer one fails to start with `GLIBC_2.<minor> not found`, which is why the `x86_64-unknown-linux-gnu` python-build-standalone builds — compiled against an older glibc — are the supported source. Extension ABI, by contrast, follows from the interpreter itself: packages installed with the mounted `pip` are tagged for that interpreter (`*.cpython-3XX-*.so`), so they cannot drift from it the way they could when the interpreter lived in the image.

Skills call `python3` (or `pip`) through `PATH`, never `/usr/bin/python3`: the image has no interpreter at that path, and the provider puts the mounted `bin` directory first. The one legacy path the image still answers is `/opt/hermes/.venv/bin/python3`, a wrapper that execs `python3` from `PATH` for skills written against that layout; with no environment mounted it fails as `python3: not found` instead of running some other interpreter.

`docker run -e PATH=…` replaces the image's value instead of extending it, so putting `<pythonRoot>/bin` first means restating the rest of the image's `PATH`: that is `toolExecImagePath`, which defaults to the Debian base image's value (`node:22-bookworm-slim`; the shipped `docker/Dockerfile` sets none of its own). Set it whenever `toolExecImage` names an image whose `PATH` differs, or the directories that image adds stop resolving inside the sandbox.

Each container also carries its own identity: `DSH_CASE_ID` and `DSH_TENANT_ID` hold the tenant id and `DSH_USER_ID` the subject, so a skill that must locate the case it runs in reads them instead of inferring identity from the container name or the `/shared` directory name — Docker sets `/etc/hostname` to the container id, which that inference cannot use.

A sandbox has no guaranteed lifetime — the host may restart, an operator may remove the container, the subject may be OOM-killed — so a cached address can go dead under a live session. When `exec` rejects (a command's own exit status travels in the result, so a rejection means transport or protocol failure), the runtime discards that sandbox, starts a replacement, and runs the same request once against it; only a second failure reaches the caller. Both execution and the `/workspace` filesystem provider go through this one path, so a replaced sandbox restores both. An exec the caller aborted is never retried.

Every step of that path is bounded, because none of it can be cancelled once issued: `cliTimeoutMs` bounds one container-CLI invocation (`run -d` includes an image pull on a host that lacks the image), `startTimeoutMs` bounds one whole cold start, and `transportTimeoutMs` bounds one tool-exec round trip — sized for the command's own execution inside the container, where a long build spends its time. A start that exceeds its bound is discarded **and its cache entry cleared**: the next call then starts a fresh container instead of joining a start that never finishes, which would otherwise leave that (tenant, user) unable to run any tool call for the life of the host process. A caller that carries its own bound (the shell deadline, the tool-timeout policy) passes it in, so an expired or aborted call stops waiting on a start in flight; the start itself continues for whoever else shares the key. A tool-exec round trip that exceeds its bound is never retried — the replacement rule above assumes a rejection means the command never ran, which a timeout cannot promise. A start that fails after `docker run -d` leaves a container under the stable name until the next start clears it.

`publishHost` and `connectHost` default to the host loopback, which assumes the harness shares the host's network namespace. A harness running in its own container reaches the published port over the Docker gateway instead: set `connectHost: host.docker.internal` and widen `publishHost` to the bridge gateway address (e.g. `172.17.0.1`). Prefer that gateway address over `0.0.0.0` — the `/exec` server authenticates nothing, so an all-interfaces publication exposes unauthenticated command execution to the surrounding network.

The tool-exec image ships the zero-dependency `/exec` server (`src/tool-exec.ts`) on Debian-slim + Node so the filesystem adapter's `stat`/`find`/`base64`/`test`/`command -v` coreutils semantics hold. Build it from the repository root:

```sh
docker build -f packages/tenant/container-docker/docker/Dockerfile \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t dsh-tool-exec:latest .
```

Keep the base slim when you override it. `docker/build-images.sh` builds this image and the host together and takes this one's base from `TOOL_EXEC_NODE_IMAGE` (default `node:22-bookworm-slim`), separately from the host's `NODE_IMAGE`: the full `node:22-bookworm` is buildpack-deps and ships `python3-minimal`, so a sandbox built on it carries an interpreter beside the mounted one and shadows it on `PATH`. Verify any build with `docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3 || echo NO-PYTHON'`, which must print `NO-PYTHON`.

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
- **The mounted Python runtime is the sandbox's only interpreter, and it is probed once, on the host.** `pythonRoot`'s layout (`bin`, `pyvenv.cfg`, `lib/python3.<minor>/site-packages`) is read when the provider is constructed, so installing further packages into that directory reaches the next sandbox while creating those paths after the host process started needs a restart. The image ships no Python, so a sandbox started without the mount has no `python3` at all, and a build needing a newer glibc than the image's Debian 12 does not start inside it. A configured `pythonRoot` that is unreadable, or that holds none of the three markers, fails the load rather than mounting nothing. The directory must also be readable at that path by the host process, not only resolvable by the Docker daemon: the provider refuses to load when a configured `pythonRoot` is not a directory it can read, and a deployment that runs the harness in its own container has to mount the host directory into that container at the same path.
