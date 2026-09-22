# Agent Note: Tool-exec sandboxes carry memory and CPU ceilings

Status: implemented

## Problem

Every (tenant, user) scope runs its tool calls in its own `dsh-tool-exec` container. The provider passed no resource flags to `docker run`, and Docker applies no ceiling of its own, so one subject's compile, test run, or data job could take memory and CPU from its co-tenants and from the host's own services. The multi-tenant deployment host (4 cores, 16 GB, shared with the case platform's containers) had no way to bound that blast radius, and `container-docker` exposed no Config field an operator could set.

The container model shaped the fix: containers start lazily per (tenant, user) and cost about 14 MB idle, so most are parked and only a few ever execute at once. A ceiling therefore protects the host without taxing parked containers — but only if it stays a ceiling.

## Decision

`Config` gains two optional fields, both passed straight to `docker run`:

- `memoryLimit` (Docker size syntax, e.g. `2g`) → `--memory <limit> --memory-swap <limit>`
- `cpuLimit` (whole cores) → `--cpus <n>`

Both are ceilings, not reservations. `--memory` is a cgroup limit: an idle container keeps costing only its own process (14 MB measured, against a 256 MB limit in the same test), and `--cpus` is CFS bandwidth, so an idle subject never holds a core back from a busy one (measured: a capped container at 0% while an uncapped sibling used 284%). Only the offending subject is stopped — exceeding the memory limit OOM-kills the process inside its own container (exit 137, `OOMKilled=true` measured on the deployment host), leaving co-tenants and the host untouched.

`--memory-swap` is pinned to the memory limit rather than left at Docker's default of twice the limit, so an over-limit subject dies in place instead of pushing the host into swap and slowing every other tenant.

An omitted field passes no flag, so single-tenant and development deployments are unchanged.

## Alternatives considered

- **Reserve memory or CPU per container** (cgroup `cpu.shares` weights, or a Kubernetes-style request/limit split): rejected. Load is spiky and mostly idle, so reservations would waste the host on parked containers and require a scheduler this provider does not have.
- **Cap memory only**: rejected. A CPU-bound subject starves co-tenants without ever tripping a memory limit.
- **A default ceiling inside the plugin**: rejected by the no-hardcoded-tunables rule — how much a host can spare is deployment-varying, so it is a validated Config field the deployment sets.
- **A disk ceiling**: not implemented. Subject writes land in bind-mounted host directories the provider does not own, so a storage quota needs a filesystem- or volume-level mechanism; recorded in the package README's Known Limitations.

## Consequences

- An operator bounds one subject's blast radius from `cordis.yml`; the multi-tenant deployment sets `memoryLimit: '2g'` and `cpuLimit: 2` alongside `idleTimeoutMs`, which bounds how many containers stay parked.
- A subject whose job legitimately needs more than its ceiling now fails as an OOM kill inside its container (exit 137) rather than succeeding slowly; ceilings are per container, so a heavier workload means editing the deployment config.
- No disk ceiling ships with this change, so a subject can still fill the host's disk through its mounts.
- Cross-links: the container model and its lifecycle come from [multi-tenant phase 2](../../proposed/architecture/2026-08-24-multi-tenant-phase-2.md) and [container-docker pre-warm](2026-08-26-container-docker-prewarm.md).
