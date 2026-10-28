# Agent Note: Bound the sandbox container's memory and CPU

Status: implemented

English | [中文](2026-10-14-sandbox-resource-limits.zh.md)

> A report sandbox's runaway `python3` took down every workload on its node because the Kubernetes provider declared no resource bound at all: `container-docker` had `memoryLimit` / `cpuLimit`, the Kubernetes provider had neither, and the tenant config rejected both names for `backend: k8s`.

## Problem

A report-generation session ran in a Kubernetes sandbox whose `python3` grew to 6.3 GB RSS (~6.85 GB of virtual address space). The Pod declared no `requests` and no `limits`, so it was `besteffort`: nothing capped the process, the kernel declared a **node-wide** OOM on the 15 Gi host, and killed it. The same event killed processes belonging to other workloads on that node, because the OOM killer picks by `oom_score_adj` and a besteffort Pod scores as killable. The sandbox container then exited 137 (`OOMKilled`) under `restartPolicy: Never`, so it was never replaced and the task died mid-flight with no report and no upload.

Neither half of that was a missing capability. `buildSandboxPod` already accepted a `resources` field, and `container-docker` already enforced `memoryLimit` / `cpuLimit` through `--memory` and `--cpus`. The Kubernetes provider never populated the field and the tenant-app config validator listed both names among the fields rejected for `backend: k8s` — the two backends' documented symmetry broke at exactly the field that protects the node, and the container-k8s README recorded the consequence as deferred work.

## Decision

- `container-k8s` gains `memoryLimit` (Kubernetes quantity, e.g. `8Gi`) and `cpuLimit` (whole cores), both optional, with the same meaning as `container-docker`'s same-named fields. The tenant-app config accepts and forwards both for `backend: k8s`.
- They render into the sandbox container's `limits` only; the provider never declares `requests`. What the cluster makes of that is not the provider's to decide: on the acceptance cluster (k8s v1.28.15) a Pod created with only `limits.memory=1Gi` comes back with an equal `requests.memory`, reproduced with a synthetic Pod in a namespace that has no LimitRange, no mutating webhook, and an empty `managedFields`. There `memoryLimit` is therefore also a reservation, and a reservation decides schedulability: the node's allocatable CPU is 4 cores, so a full-core `cpuLimit` leaves the sandbox Pod permanently `Pending` with `Insufficient cpu`, and the deployment configures `memoryLimit: 6Gi` with no `cpuLimit`. Where a namespace does leave the Pod limits-only it stays `Burstable` and bursts; overrun is killed inside its own cgroup either way.
- `assertQuantity` validates the value at load. The apiserver also rejects a malformed quantity, but only at Pod creation, with a message about the assembled spec rather than the config field.
- The value is a Kubernetes quantity, so the literal syntax differs between backends for the same meaning: docker writes `2g`, Kubernetes writes `8Gi`. A value that is valid for one is rejected loudly by the other rather than silently rounded.

## Alternatives considered

- **Declare `requests` too.** Rejected: it pins each sandbox's memory on the node permanently, while sandboxes are used intermittently and burst.
- **Expose the Kubernetes resources object as configuration.** Rejected: it would make the whole resource model part of this deployment's config surface, when the quantity that needs a bound is memory and CPU.
- **Normalize docker-style suffixes (`2g`) into quantities.** Rejected: it guesses intent for a value the operator typed, and a loud rejection names the field instead.

## Consequences

- Deployments that leave `memoryLimit` unset keep unbounded sandboxes. The container-k8s README states this as a production requirement rather than leaving it as deferred work, since the failure mode is a node-wide OOM rather than a slow sandbox.
- Declaring limits changes the Pod spec, so its fingerprint changes: a sandbox created before the change is refused with "runs a different spec" until it is replaced. Deploy during a quiet window, or delete the terminal sandbox.
- CPU is rendered as `String(cores)`, so the docker-style `2` and the quantity `2` mean the same two cores.
- The bound is enforced by the kernel, not merely recorded: with `memoryLimit: 6Gi` the acceptance cluster's sandbox container reads `/sys/fs/cgroup/memory.max` as `6442450944`, so a runaway command is killed inside its own cgroup instead of taking the node down with it.
- These values are read from the tenant config at host startup, so changing them restarts the host. The acceptance deployment rolls with the `Recreate` strategy: the old Pod is deleted first and its replacement ReplicaSet can appear a minute or more later, so the tenant plane is briefly unavailable and the change belongs in a quiet window.
- Cross-links: the docker half of this decision is [Tool-exec sandboxes carry memory and CPU ceilings](2026-09-22-sandbox-resource-ceilings.md), and the capture bound that keeps a `find /` from reaching the ceiling by accident is [Bounding what a sandbox command may emit](2026-10-08-sandbox-output-bound.md).

### Verification

- `packages/tenant/container-k8s/tests/pod-spec.spec.ts` pins the assembly and the load-time validation: a Pod built with the fields carries `limits.memory` / `limits.cpu` and no `requests`, one built without them carries no `resources` at all, and `assertQuantity` accepts `8Gi`, `500m` and `2` while rejecting the docker spelling `2g` with the field named.
- `packages/tenant/container-k8s/tests/runtime.spec.ts` reads the spec the provider actually hands the cluster: with both fields configured the created Pod carries `limits.memory: 8Gi` and `limits.cpu: '2'`, and without them it carries none.
- `packages/tenant/tenant-app/tests/app.spec.ts` asserts the config accepts and forwards both fields for `backend: k8s`, resolving `memoryLimit: 8Gi` / `cpuLimit: 2` into `{backend: 'k8s', memoryLimit: '8Gi', cpuLimit: 2}`.
- 13 test files and 211 tests pass; `pnpm run typecheck` is clean, and lint reports no new finding in the changed files.
- On the acceptance cluster the bound reaches the kernel: with `memoryLimit: 6Gi` the sandbox Pod carries `{"limits":{"memory":"6Gi"},"requests":{"memory":"6Gi"}}` and the container reads `/sys/fs/cgroup/memory.max` as `6442450944`. A session whose previous sandbox died of the node-wide OOM (exit 137, `OOMKilled`, `restartPolicy: Never`) now runs in that bounded Pod.