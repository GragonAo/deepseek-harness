# @deepseek-ai/dsh-agent-http

English | [中文](README.zh.md)

The multi-tenant agent HTTP carrier (`ctx.agentHttp`): a stateless Request → Response function that wraps the single-user gateway ([`@deepseek-ai/dsh-host-apiproxy`](../../host/apiproxy/README.md)) with bearer authentication and request-scoped tenant + user authority. Every request verifies a credential through `ctx.tenantAuth`, resolves the tenant and checks membership through `ctx.tenants.resolveMember`, and enters `runWithTenant` + `runWithUser` before delegating the whole request to `toFetchHandler(ctx.apiProxy)`, so the tenant- and user-scoped providers behind the gateway's RPC methods (`session-persistence-postgres`, `subprocess-container`, `fs-container`, `container-docker`) resolve through `requireTenant()` / `requireUser()`. Because the shared gateway exposes every in-process session, the carrier also scopes `session.list`/`session.search` and the session-scoped frames on the `events.mux`/`events.host` streams to the ambient `(tenant, user)`'s sessions. A live-session ownership map `sessionScopes` (fed by `session/created` under the ambient `currentTenant()` + `currentUser()`, released on `session/disposed`) backs `owns(sessionId, tenant, user)` — true for a cold session or a matching live owner — which filters both surfaces.

The carrier owns no agent or session state. When a `webServer` service is present it registers the `/api` prefix route itself — a node:http fetch bridge replacing the single-user `client-connection` trust fence, so `dsh web` serves the multi-tenant API with no separate adapter. Authentication and tenant resolution fail closed before any method runs: `TenantAuthError` is a 401 with `WWW-Authenticate: Bearer`, `TenantError` (`TENANT_UNKNOWN`/`TENANT_DISABLED`/`NOT_A_MEMBER`) is a 403, and any other throw is a logged 500.

## Model Experience

None, as the package only authenticates and scopes one gateway request; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Host-plane frames (no session id) pass through unchanged.** Session-scoped frames on both downlinks — the mux stream plus `host/session-added|removed|status|agent-error` and `host/archived-sessions-changed` — are scoped to the ambient `(tenant, user)`, but the host stream's `host/workspace-*` snapshots and the `remote-event` allowlist (`agent-preset/selected`, `commands/change`, `credentials/updated`, `settings/document-updated`, …) carry shared host composition rather than any `(tenant, user)`'s sessions, so they are forwarded verbatim.
