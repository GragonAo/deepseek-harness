# @deepseek-ai/dsh-tenant-demo

English | [中文](README.zh.md)

Runnable end-to-end multi-tenant slice. It assembles bearer-JWT auth ([`tenant-auth-jwt`](../tenant-auth-jwt)), per-tenant Postgres sessions ([`session-persistence-postgres`](../session-persistence-postgres)), the per-tenant container execution world ([`container-docker`](../container-docker) + [`subprocess-container`](../subprocess-container) + [`fs-container`](../fs-container)), and the tenant HTTP API ([`api-http`](../api-http)) behind one bootable entry: `assembleDemo`.

The demo operation proves the whole chain per request: authenticate → resolve the tenant → run one container tool call inside that tenant's own container (its workspace mounted at `/workspace`, tooling at `/tools`) → read the result back in-world → persist a session event to that tenant's schema.

## Run

```sh
docker compose -f packages/tenant/tenant-demo/docker-compose.yml up -d

TEST_POSTGRES_URL=postgres://dsh:dsh-local@127.0.0.1:5432/dsh \
  pnpm exec vitest run packages/tenant/tenant-demo/tests
```

The integration test self-skips without `TEST_POSTGRES_URL` or when no container runtime is reachable. Set `TEST_CONTAINER_RUNTIME=podman` to use Podman. The test warms the `dsh-tool-exec:latest` image the container runtime launches; build it first with `docker build -f packages/tenant/container-docker/docker/Dockerfile -t dsh-tool-exec:latest .`.

## Model Experience

### Tenant-scoped demo request

#### What the model sees

Nothing. The slice serves the external HTTP client via `ctx.tenantHttpApi`; it ships no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **Assembly-only.** The package boots the providers on a hand-built Cordis context for the slice; production deployments compose them through the Loader and a `cordis.yml`.
- **No full HTTP request/response schema.** Bodies are free-form JSON; the operation is single-slot.
- **No agent loop.** The demo operation runs one container tool call directly — it does not dispatch a model turn.