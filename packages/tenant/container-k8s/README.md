# @deepseek-ai/dsh-container-k8s

The Kubernetes tenant container runtime: one bare sandbox Pod per (tenant, user), addressed by podIP.

It implements the `container` Service Definition, so it is a drop-in replacement for
`@deepseek-ai/dsh-container-docker` at the row that mounts a tenant execution world. A sandbox
is a bare Pod, never a Deployment or Job: nothing recreates it, so `delete` is complete, and no
controller holds a copy of the mount set that could drift from the one this provider computes.

## Model Experience

None. The provider moves commands into a Pod and returns their stdout, stderr, and exit code; it
adds no tokens, no tools, and no prompt content.

## How a sandbox is addressed

Commands never travel through `kubectl exec`. The Pod runs the same tool-exec HTTP service the
docker provider runs, and this provider posts to `http://<podIP>:<toolExecPort>`. Two consequences
follow, and both are why the design is shaped this way:

- The host needs no `pods/exec` permission. Its Role grants `pods` get/list/watch/create/delete,
  `pods/log` get, and `events` get/list/watch, and nothing else.
- The host needs no container-runtime socket. The docker provider requires
  `/var/run/docker.sock` mounted into the host process; this one requires no host surface at all.

## Mounts

Each mount is a `hostPath` volume whose `path` is the host directory and whose `mountPath` is where
the sandbox sees it. The two are deliberately different for `/workspace`, `/shared`, `/global`, and
`/tools`, and identical for the skill tree, the system tier, and the Python runtime, whose
in-sandbox location is derived from their host location by the components that read them.

`hostPath.type` is `Directory`, so a missing source fails the volume mount instead of producing an
empty directory. That failure never reaches the sandbox: the kubelet refuses the volume before the
init container starts, leaving the Pod in `Pending` with the reason only in events. The provider
reads those events when a start times out (`readEvents`), because a bare `Pending` tells an operator
nothing about which path to create.

An init container reusing the sandbox image then verifies every mount from inside, checking the
mount path rather than the host source: the host path is not present in the sandbox filesystem
whenever the two differ. This is the only check that can distinguish a working mount from a
directory the container runtime created because the source was absent.

## The spec fingerprint

Each Pod carries a `dsh.dev/spec-fingerprint` annotation, a SHA-256 over the resolved Pod spec. On
every call the provider compares a running sandbox's annotation with the digest it would build now:
equal adopts the sandbox, different deletes and recreates it. The digest is order-independent, so
two hosts reading the same configuration agree; an order-sensitive digest would make every restart
recreate every sandbox.

## Configuration

`namespace` and `image` are required and validated at load. `RESERVED_NAMESPACES` rejects the
cluster's own namespaces and the co-tenant business namespaces, because a wrong namespace value
would place sandboxes beside unrelated production workloads and could delete by name. Everything
else is optional with a schema default: `kubectlBinary`, `imagePullPolicy`, `toolExecPort`,
`usersRoot`, `systemRoot`, `toolsRoot`, `pythonRoot`, `command`, `env`, and the `cliTimeoutMs` /
`startTimeoutMs` / `readyPollMs` bounds.

`workspaceRoot` is not configuration. One provider instance serves every tenant while each tenant
owns a distinct workspace tree, so the root is read from the tenant record and passed to
`sandboxMounts`; a provider-level value could only be wrong for all but one tenant.

## Known Limitations and Deferred Work

- **`hostPath` is the only volume source.** A single-node cluster with no StorageClass needs no
  more, but a multi-node deployment requires a `PersistentVolumeClaim` per mount source, and the
  same-path rule that makes `hostPath` correct does not survive a shared claim. The Pod builder
  takes a mount list, so the change is confined to `sandboxMounts` and the volume construction.
- **Sandbox start is not pooled.** A cold Pod takes seconds where a docker container takes
  milliseconds, and the idle-reclaim behavior this provider inherits means a busy tenant pays that
  cost repeatedly. A prewarmed Ready pool would need an owner for the Pods between sessions.
- **No resource requests.** `requests` and `limits` are not set, so the scheduler cannot reserve
  for a sandbox and the kubelet cannot enforce a memory bound. The docker provider bounds a sandbox
  with `memoryLimit` / `cpuLimit`; those have no equivalent here yet.
- **Events are read only on a start timeout.** A sandbox that starts and then fails has its
  container state in the failure message but not the events that explain it.
- **The network is the cluster's.** The docker provider's `tenant.network: none` has no equivalent:
  no NetworkPolicy controller is installed, so a sandbox can reach anything the cluster can.
