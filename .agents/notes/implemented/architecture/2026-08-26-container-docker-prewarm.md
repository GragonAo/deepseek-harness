# Agent Note: Container-docker pre-warms tenants under stable names

Status: implemented

English | [中文](2026-08-26-container-docker-prewarm.zh.md)

## Problem

The `container-docker` runtime started each tenant's tool-exec container lazily, on the first `exec`, under a freshly minted `dsh-<partition>-<random>` name. Two costs followed. The moment a tenant's first request reached a tool, it paid the whole container cold-start — `docker run`, port publication, and the in-container Node bind readiness wait (~0.5s on the deployment host) — before any work ran. And because teardown (`docker rm -f` per container) only ran on a graceful dispose, a host that restarted by kill left the old random-named container running while the new process minted another, so orphaned containers accumulated across restarts and never reconciled.

## Decision

Pre-warm each enabled tenant's container at boot and give every tenant one stable, tenant-partitioned name. `DockerContainerRuntime` now declares `static inject = ['tenants']` and a `[Service.init]` generator that iterates the tenant registry and, for every enabled tenant, fires `ensure(tenant)` without awaiting it — so boot never blocks on docker latency, and a request that races the warm joins the already-in-flight start through the existing `starting` map (at most one cold-start per process). `startContainer` drops the random suffix: the name is `dsh-<partition>`, and it runs `docker rm -f` for the same name before `docker run` (a no-op when absent), so a non-graceful shutdown can at most leave one container that the next start clears.

## Alternatives considered

- **Keep lazy start and random names** (status quo): rejects — the first tool call still pays the cold-start and a crash still orphans a container per restart.
- **Boot-time prune of every `dsh-*` container**: rejects — freshness cannot distinguish this process's containers from a concurrently starting peer's, so pruning evicts a live tenant world.
- **Adopt-or-create the stable name** (inspect the running `dsh-<partition>`, reuse its port, and only start when absent): deferred — it removes the cold-start and the eviction even across overlapping processes, but requires inspecting mounts and health, which is not yet needed by the single-host deployment.

## Consequences

- A tenant's tools now run against a warm container from the first call; the cold-start moved off the request path into process boot, and a request during the warm shares one start.
- The stable name pins each tenant to at most one container per Docker host, so restarts no longer accumulate orphans; a same-name container is cleared before the next start.
- The stable name also means two `dsh` processes that start in overlapping succession on one host re-create (evict) each other's same-name container — harmless re-warm here, but a shared-host multi-replica deployment that must hand off mid-traffic would want adopt-or-create instead (recorded in the package README's Known Limitations).

### Verification

- `packages/tenant/container-docker/tests/docker.spec.ts` now asserts: the pre-warm loop starts one container per enabled tenant (disabled tenants skipped) under `dsh-tenant_<id>_<hash>` and clears the same name first, and that the idle budget reaches the container as `DSH_TOOL_EXEC_IDLE_MS`, which the container enforces itself ([why the host stopped reaping](2026-10-08-container-owned-sandbox-lifetime.md)).
- Measured on the deployment host (`192.168.138.130`): cold start ≈ 524ms (`docker run` ≈ 351ms, port ≈ 46ms, readiness ≈ 127ms) versus ≈ 16ms for a warm exec; the pre-warm eliminates the cold path from every tenant request.
