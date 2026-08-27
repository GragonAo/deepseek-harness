# @deepseek-ai/dsh-api-http

English | [中文](README.zh.md)

Stateless tenant HTTP API (`ctx.tenantHttpApi`). One exact route authenticates a bearer credential through `ctx.tenantAuth`, resolves the tenant through `ctx.tenants` (fail-closed on unknown/disabled), enters `runWithTenant`, and runs a single registered request operation. No agent or session state lives in this process layer — the operation derives everything from the tenant scope and the storage/container providers behind it.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-api-http'
  config:
    path: '/v1/run'
```

It injects `webServer` (route registration), `tenantAuth`, and `tenants`. The composing application calls `ctx.tenantHttpApi.register(operation)`, where `operation({ tenant, principal, body })` runs inside the tenant's scope.

## Model Experience

### Authenticated tenant-scoped HTTP request

#### What the model sees

Nothing. The `ctx.tenantHttpApi` route serves an external API client, not a model: no tools, prompts, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- **One operation and one route.** The service is a single-slot endpoint; multi-route or schema-validated request/response surfaces are out of the slice.
- **No per-call authorization beyond the tenant.** `principal.scopes` is forwarded to the operation but not enforced here.
- **Body is parsed as JSON with no size cap** — the operation owner bounds the complete result.