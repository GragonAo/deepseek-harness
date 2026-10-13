# Agent Note: A Kubernetes provider for the tenant container runtime

Status: implemented

## Problem

The multi-tenant backend mounts one execution world per (tenant, user) through the `container` Service Definition. `dsh-container-docker` implements it by publishing a container's tool-exec port on the host loopback, which forces the deployment to run the host with `network_mode: host` and to mount `/var/run/docker.sock` into it. A single-node cluster deployment cannot do either.

## Decision

`@deepseek-ai/dsh-container-k8s` implements the same Service Definition with one bare sandbox Pod per (tenant, user), addressed by podIP over the same tool-exec HTTP service.

Bare Pod, not Deployment or Job: nothing recreates a sandbox, so `delete` is complete and no controller holds a mount set that could drift from the one the provider computes. What a sandbox's own lifetime needs instead is recorded in [A sandbox decides its own lifetime](2026-10-08-container-owned-sandbox-lifetime.md).

Commands never travel through `kubectl exec`. This is what removes both privileged surfaces: the host Role grants `pods` get/list/watch/create/delete, `pods/log` get, and `events` get/list/watch, so it needs no `pods/exec`, and it needs no container-runtime socket. Verified on the cluster: a POST to the sandbox tool-exec port returned exit code 0 and the echoed argument.

### What the cluster corrected

Four findings that reading the code could not produce; each changed the design.

**A failing volume is invisible to the container.** `hostPath.type: Directory` on a missing source makes the kubelet refuse the volume before the init container starts, leaving the Pod in Pending with the reason only in events. The intended belt-and-braces layering was backwards: the init container cannot report what it never reaches. `readEvents` now reads those events when a start times out. Measured: seven FailedMount events, Init:0/1, no other signal.

**The init check must name the mount path, not the host source.** For /workspace, /shared, /global, and /tools the two differ, and the host path does not exist inside the sandbox, so the check failed every such mount on a healthy host. `buildSandboxPod` now derives the paths from the mounts rather than accepting them, so a caller cannot pass the wrong ones.

**A claim may be named by exactly one volume.** `hostPath` mode gave every mount its own volume, and claim mode inherited that shape: seven mounts of one claim became seven `volumes` entries naming the same claim. The kubelet records mount state per backing volume, so six stayed `unmounted` for good and every sync ended in `context deadline exceeded` (`pod_workers.go:1300`), leaving the Pod before its init containers with no event naming the cause. Measured on the cluster: a Pod with two volumes naming one claim reproduces it; a Pod with one volume and seven `subPath` mounts starts. `volumesFor` now emits one volume per backing store, and `subPath` stays on the `volumeMounts` entry — the only place Kubernetes accepts it. The init verifier's own mounts carried no `subPath` either, so the check it exists to make, that the sandbox sees the tenant's subtree rather than the claim root, was vacuous; both containers now build their mounts through one `mountSite`.

**A fingerprint must be order-independent.** The spec renders env as an array, and the canonical form sorted object keys but not array order, so two hosts reading the same configuration disagreed about whether a running sandbox was current. Adopt-or-create would have recreated every sandbox on every restart.

## Alternatives considered

- **Keep `docker exec` into the host's containers** (what `container-docker` does): rejects — it needs the container-runtime socket in the host, so the host holds a privileged surface the cluster cannot scope by Role.
- **One Deployment or Job per sandbox**: rejects — a controller recreates or holds a sandbox, so `delete` stops being the complete end of one, and a Job's generated Pod name cannot be the stable name adoption across replicas needs.
- **`hostPath` mounts for every tier**: rejects on a multi-node cluster — the tenant tree has to come from a claim every node can mount, which is also why a claim mount keeps its shape in one volume per backing store.

## Consequences

- `workspaceRoot` is not provider configuration. One provider instance serves every tenant while each tenant owns a distinct workspace tree, so the root is read from the tenant record and passed to `sandboxMounts`.
- `namespace` and `image` are required and validated at load; the provider rejects the four namespaces every cluster owns and nothing else, because those are the only wrong values decidable from the configuration alone. Names belonging to one cluster are deliberately not enumerated — a constant naming a co-tenant's business namespace ships that cluster's topology to every deployment — and a wrong value there is caught by the cluster instead, whose Role for the host ServiceAccount reaches exactly one namespace.
- No NetworkPolicy controller is installed, so an unshared network has no equivalent and a sandbox can reach whatever the cluster can. The isolation boundary is the filesystem only; the package README records this and the provider's other gaps.
- The provider runs in the `dsh` namespace of the single-node cluster, on a host image built with it: sandbox Pods carry this provider's annotations and mount the tenant tree as `subPath` of the shared `dsh-workspace` claim. The container-runtime row provider name is fixed by the dsh-multi-tenant bundle, so a patch layer that does not restate it is skipped with a name mismatch warning: swapping the provider requires rebuilding the host image, which is how this cluster was switched.

### Verification

- A POST to a sandbox's tool-exec port returned exit code 0 and the echoed argument, on the cluster this provider was written for.
- The two volume findings were measured on that cluster: a Pod with two volumes naming one claim reproduces the stuck mount, and a Pod with one volume and seven `subPath` mounts starts.
- `packages/tenant/container-k8s/tests/` covers the Pod spec, the fingerprint's order independence, adoption, replacement, and the start deadline; 23 tests pass in `runtime.spec.ts` and 20 in `pod-spec.spec.ts`.
