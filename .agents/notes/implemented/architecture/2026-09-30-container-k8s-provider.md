# A Kubernetes provider for the tenant container runtime

Date: 2026-09-30

## Context

The multi-tenant backend mounts one execution world per (tenant, user) through the `container`
Service Definition. `dsh-container-docker` implements it by publishing a container's tool-exec port
on the host loopback, which forces the deployment to run the host with `network_mode: host` and to
mount `/var/run/docker.sock` into it. A single-node cluster deployment cannot do either.

## Decision

`@deepseek-ai/dsh-container-k8s` implements the same Service Definition with one bare sandbox Pod
per (tenant, user), addressed by podIP over the same tool-exec HTTP service.

Bare Pod, not Deployment or Job: nothing recreates a sandbox, so `delete` is complete and no
controller holds a mount set that could drift from the one the provider computes.

Commands never travel through `kubectl exec`. This is what removes both privileged surfaces: the
host Role grants `pods` get/list/watch/create/delete, `pods/log` get, and `events` get/list/watch,
so it needs no `pods/exec`, and it needs no container-runtime socket. Verified on the cluster: a
POST to the sandbox tool-exec port returned exit code 0 and the echoed argument.

## What the cluster corrected

Three findings that reading the code could not produce; each changed the design.

**A failing volume is invisible to the container.** `hostPath.type: Directory` on a missing source
makes the kubelet refuse the volume before the init container starts, leaving the Pod in Pending
with the reason only in events. The intended belt-and-braces layering was backwards: the init
container cannot report what it never reaches. `readEvents` now reads those events when a start
times out. Measured: seven FailedMount events, Init:0/1, no other signal.

**The init check must name the mount path, not the host source.** For /workspace, /shared, /global,
and /tools the two differ, and the host path does not exist inside the sandbox, so the check failed
every such mount on a healthy host. `buildSandboxPod` now derives the paths from the mounts rather
than accepting them, so a caller cannot pass the wrong ones.

**A fingerprint must be order-independent.** The spec renders env as an array, and the canonical
form sorted object keys but not array order, so two hosts reading the same configuration disagreed
about whether a running sandbox was current. Adopt-or-create would have recreated every sandbox on
every restart.

## Configuration

`workspaceRoot` is not provider configuration. One provider instance serves every tenant while each
tenant owns a distinct workspace tree, so the root is read from the tenant record and passed to
`sandboxMounts`.

`namespace` and `image` are required and validated at load; `RESERVED_NAMESPACES` rejects the
cluster own namespaces and the co-tenant business namespaces, because a wrong value would place
sandboxes beside unrelated production workloads and could delete by name.

## Known limitations

Recorded in the package README. The one with security content: no NetworkPolicy controller is
installed, so an unshared network has no equivalent and a sandbox can reach whatever the cluster
can. The isolation boundary is the filesystem only.

## Deployment status

The provider is complete and verified against a real cluster, but it is not yet mounted into the
host: the container-runtime row provider name is fixed by the dsh-multi-tenant bundle, and a patch
layer that does not restate it is skipped with a name mismatch warning. Swapping the provider
therefore requires rebuilding the host image, which is the remaining work.
