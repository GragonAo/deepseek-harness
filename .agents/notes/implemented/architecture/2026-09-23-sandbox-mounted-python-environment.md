# Agent Note: Sandboxes mount a host-maintained Python environment

Status: implemented

English | [中文](2026-09-23-sandbox-mounted-python-environment.zh.md)

## Problem

The multi-tenant deployment runs on an internal network with no internet access, so a case skill's Python dependencies cannot be installed at container start, and putting them in the tool-exec image means every dependency change rebuilds that image and redistributes it to every host. Operations asked for the opposite: one Python environment maintained on the host, mounted into the execution layer, so that updating that one directory updates every sandbox.

Keeping an interpreter in the image left two sources of truth for one runtime. The image's Python fixed the ABI every mounted package had to match, so moving to a newer Python meant rebuilding and redistributing that image, and the dependencies its build installed were a snapshot no case could extend without another image. Operations asked for one directory to be the whole answer — interpreter version and packages together — which only holds if the image ships no interpreter at all.

Mounting a virtual environment built elsewhere fails inside the sandbox. A vendored environment whose `bin/python3` symlinked to `/root/miniconda3/envs/py313` had no interpreter in the sandbox at all, and its compiled extensions were tagged for that interpreter.

A skill that must locate the case it runs in had only the container name and the `/shared` directory name to infer identity from, and Docker sets `/etc/hostname` to the container id, so that inference has nothing to read. The platform knows the tenant and the subject; the sandbox did not.

## Decision

`container-docker` `Config` gains `pythonRoot`, a host directory mounted read-only at its own absolute path (`-v <pythonRoot>:<pythonRoot>:ro`), and every container also receives its identity as environment variables.

The provider reads `pythonRoot`'s layout once, on the host, when it is constructed: the container's start arguments are fixed for its lifetime, so the probe does not belong in the sandbox's own shell logic. The reads go through the injected `HostPathProbe` (`src/python-env.ts`), so a test resolves the layout without touching the host filesystem. Three independent probes decide three variables:

- `<pythonRoot>/bin` exists → `-e PATH=<pythonRoot>/bin:<toolExecImagePath>`. `docker run -e PATH=` replaces the image's value instead of extending it, so the prepend restates the image's own PATH, which `Config.toolExecImagePath` carries (default: the shipped image's Debian base PATH, `node:22-bookworm-slim`).
- `<pythonRoot>/pyvenv.cfg` exists, marking a virtual environment → `-e VIRTUAL_ENV=<pythonRoot>`.
- `<pythonRoot>/lib/python3.<minor>/site-packages` exists → `-e PYTHONPATH=` those directories joined with `:`, which also reaches an interpreter a deployment installs into its own image; the mounted interpreter finds its own site-packages without it.

Omitting the field mounts nothing, sets no Python variable, and never consults the probe, so a deployment that maintains no such directory keeps its previous behavior exactly. A configured `pythonRoot` that is not a directory this process can read fails the load instead: the harness reads that directory itself before handing the path to the container runtime, so a path only the Docker daemon resolves — the usual cause being a host directory not mounted into the container the harness itself runs in — would otherwise mount an empty directory and configure nothing. A directory this process can read but that holds none of the three markers fails the load for the same reason, and Docker creating a missing bind-mount source as an empty directory is what makes that state the one a never-built environment actually presents. A directory holding any one of the markers stays legal and configures that one alone.

The tool-exec image ships no Python, so the mounted directory is the sandbox's only interpreter and has to be a complete relocatable build. A virtual environment is not one: `python3 -m venv --copies` copies the interpreter executable, but that executable still loads its standard library and `libpython` from the system it was created on, and no such system is left in the sandbox. A `python-build-standalone` `x86_64-unknown-linux-gnu` `install_only` tree — or a complete conda environment — is the supported source: unpack it where there is internet access, install the case tooling with its own `pip` from inside a container (the tool-exec image has no Python to run that pip with), then copy the whole directory to the internal host at the path the sandbox mounts.

```sh
tar -xzf cpython-3.11.*-x86_64-unknown-linux-gnu-install_only.tar.gz && mv python pyenv
docker run --rm -v "$PWD/pyenv:/pyenv" -e PATH=/pyenv/bin:/usr/bin:/bin \
  --entrypoint sh dsh-tool-exec:latest -c 'python3 -m pip install openpyxl xlrd pandas'
rsync -a pyenv/ <internal-host>:/opt/.dsh/pyenv/
```

The one version constraint is on the build rather than on the extensions: the mounted Python must run on the image's glibc — the image is Debian 12 (glibc 2.36), and a build made for a newer one fails to start inside it, which is why the `x86_64-unknown-linux-gnu` python-build-standalone builds are the supported source. Extension ABI, by contrast, follows from the interpreter instead of having to match a separate one: packages installed with the mounted `pip` are tagged for that interpreter (`*.cpython-3XX-*.so`). Skills call `python3` (or `pip`) through `PATH`, never `/usr/bin/python3`, and the one legacy path the image answers, `/opt/hermes/.venv/bin/python3`, is a wrapper that execs `python3` from `PATH` for skills written against that layout.

Identity travels in the same start arguments: `DSH_CASE_ID` and `DSH_TENANT_ID` carry the tenant id, and `DSH_USER_ID` carries the subject (`UserId`, which is the authenticated subject string itself). The container process environment reaches every command the tool-exec server spawns, so a skill reads its own case instead of inferring it.

The multi-tenant bundle sets `pythonRoot: /opt/.dsh/pyenv` on the `container-runtime` row, and `docker/docker-compose.multi-tenant.yml` mounts that host directory into the harness container at the same path: the probe runs in the harness process, so that mount is what makes the row's configuration succeed.

## Alternatives considered

- **Keep an interpreter in the image and mount only packages**: rejected. The image's Python would still fix the ABI every mounted package has to match, so a Python version bump would still be an image rebuild, and the mount would have to be built to fit it rather than being the whole answer. It also means a build the image no longer needs (the pip bootstrap and its index URL) and an interpreter version to keep in step with the mounted directory.
- **Bake the case dependencies into the tool-exec image**: rejected. Adding a dependency a case skill needs later would require a reachable mirror at build time and a rebuilt, redistributed image on every host — the constraint this change exists to remove.
- **Prepend to `PATH` inside the container**, from the entrypoint or a shell wrapper: rejected. The probes would then run inside the sandbox, where an absent directory is indistinguishable from a misconfigured mount, and the environment would depend on the sandbox's own logic instead of fixed start arguments.
- **Mount the environment at a fixed in-container path** and point the variables there: rejected. A virtual environment records its own absolute path in `pyvenv.cfg`, its shebangs, and its `.pth` files, so the sandbox must see the directory at the path it was built at — the same rule the system skill tree follows ([sandbox system skill mount](2026-09-22-sandbox-system-skill-mount.md)).
- **Ship an interpreter in the image as a fallback for a missing mount**: rejected. A fallback is a second source of truth: a skill that resolves it runs a version the mounted packages were not built for, and the failure surfaces as an import error instead of the missing mount.
- **Inject identity through each tool-exec request's `env`** instead of the container's: rejected. `docker run -e` reaches every process in the sandbox, including one a skill spawns itself, while a per-request `env` reaches only the argv the provider sends.
- **A separate capability package for the mounted environment**: rejected. One config field and one mount on the provider that owns the container's start arguments; a package of its own would need a Service Definition and a consumer for a single deployment concern.

## Consequences

- A no-internet deployment installs a package into one host directory and the next sandbox start sees it, with no image rebuild and no host restart. Creating `bin`, `pyvenv.cfg`, or `lib` in that directory after the host process started does need a restart, because the layout is probed once at construction.
- The mount is a hard dependency, not an optimization: a sandbox started without it has no `python3` at all (`command -v python3` is empty, and `/opt/hermes/.venv/bin/python3` fails with `python3: not found`, exit 127). A deployment that never sets `pythonRoot` therefore has no interpreter where the image used to supply one, and the case tooling the image used to install — the xlsx readers among it — has to be part of the mounted directory.
- The image's build no longer reaches a package index: it needs only the npm registry for esbuild, so building it on an internal host does not depend on a PyPI mirror, and nothing in the image pins an interpreter version.
- Failing loud covers the ordering requirement instead of leaving it to operations: the host directory has to exist and hold an environment before `pythonRoot` is configured, or the host refuses to start. Docker creates a missing bind-mount source as an empty directory, and that empty directory is refused too, so a deployment that skipped building the environment stops at load rather than running sandboxes with no interpreter — the reminder is not what protects it.
- `pythonRoot` must be readable by the host process at that path as well as resolvable by the Docker daemon. A deployment that runs the harness in its own container mounts the host directory into that container; without that mount the load fails with the path named, instead of mounting an empty directory and setting no Python variable.
- One environment serves every tenant: a package installed into it is available to every tenant's sandbox, read-only. Per-tenant Python isolation would need a per-tenant root.
- `toolExecImagePath` restates the image's own PATH because `docker run -e PATH=` replaces it. It defaults to the shipped image's Debian base PATH; a deployment supplying its own `toolExecImage` whose PATH carries further directories sets this field to match, or those directories stop resolving while `pythonRoot` is set.
- A deployment patch that targets the `container-runtime` row replaces that row's whole `config` object, so it has to restate `usersRoot`, `pythonRoot`, and the bounds alongside whatever it adds. The fields it omits fall back to their schema default, which for the two roots is no value.
- `DSH_TENANT_ID` and `DSH_CASE_ID` carry the same id: in this product a case is the tenant.

### Verification

- `packages/tenant/container-docker/tests/docker.spec.ts` covers the mounted environment as a read-only same-path mount with `PATH` prepended, `VIRTUAL_ENV`, and `PYTHONPATH` set; a directory holding only `bin` getting `PATH` alone; no `pythonRoot` mounting nothing, setting no Python variable, and never probing; a configured `pythonRoot` that is missing or a file failing the load with the path in the message; an existing directory holding none of the three markers failing the load with the path in the message; a configured `toolExecImagePath` appearing in the restated `PATH`; and the three identity variables carrying the ambient tenant and subject ids. Its `hostPathProbe` suite covers the production host reads against a temporary directory. 26 tests pass in that file.
- `packages/tenant/tenant-demo/tests/multi-tenant-loader.spec.ts` pins the composed `container-runtime` row at a temporary directory, so the real-composition boot does not depend on the machine running it having `/opt/.dsh/pyenv`.
- `npx tsc -p packages/tenant/container-docker/tsconfig.json --noEmit` is clean.
- `docker build -f packages/tenant/container-docker/docker/Dockerfile -t dsh-tool-exec:latest .` succeeds, and `docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3; command -v pip3'` prints nothing: the image carries no interpreter.
- The mount was exercised against the built image with a `python-build-standalone` `cpython-3.11.16` `x86_64-unknown-linux-gnu` `install_only` tree mounted read-only at `/opt/.dsh/pyenv`, `PATH` prepended with its `bin`, and the case tooling installed into that tree by its own `pip` running inside the Python-less image: `python3 -V` reported 3.11.16, `sys.executable` and `sys.prefix` both resolved under the mount, `/opt/hermes/.venv/bin/python3` ran, and `import openpyxl, pandas` succeeded (3.1.5, 3.0.6). Without the mount the same image reports `python3: not found` and that wrapper exits 127.
