# Agent Note: MCP calls carry the inbound request context

Status: implemented

English | [中文](2026-10-26-mcp-call-meta-from-request-headers.zh.md)

## Problem

An MCP server that authorizes per caller reads the caller's identity and case from `params._meta`. The ICAC case server answers `403 用户无权限查看该案件` when the pair is wrong, and records `identity_source: none` with empty `case_id`/`user_id` when the field is absent. The bridge sent `params: { name, arguments }` only, so every call reached that server as its own service account with no case: one identity for every tenant user, and no per-user isolation to audit.

The two obvious channels do not carry it. The server ignores inbound HTTP headers (verified against the running server: `X-User`/`X-Case`/`Authorization` leave `mcp_call_log` unchanged), and `mcpServers[].headers` is a connection-level constant fixed at load, so it cannot vary per caller.

## Decision

Three pieces, one mechanism:

- `@deepseek-ai/dsh-tenant` adds `runWithRequestHeaders(headers, fn)` / `currentRequestHeaders()` — a module-scoped `AsyncLocalStorage` beside the tenant, user, and scope authority it already carries.
- `@deepseek-ai/dsh-tenant`'s carrier (`@deepseek-ai/dsh-agent-http`) enters the inbound request's headers (lowercased names) around the delegation it already scopes. A tool call happens later in the agent loop but inside the same asynchronous execution tree, which is what makes the store readable there.
- `@deepseek-ai/dsh-mcp-client` consumes an optional `ctx.mcpCallMeta` service: `entries()` is read per call and merged into `params._meta`. No service, no `_meta` — an integration that does not need the channel is byte-identical to before.
- `@deepseek-ai/dsh-tenant-app` provides it from `mcpMeta.fromHeaders` (`_meta` key → header name), mounted only when configured. A mapped header the request did not carry is omitted rather than sent empty, so the server can tell "this caller named no case" from "the case is the empty string".

The mapping lives in deployment config, not in code: which header carries a user or a case is a fact between the caller and that server.

## Alternatives considered

- **Static `mcpServers[].headers`**: rejected — one value per server for every user of the tenant, which is the limitation being fixed.
- **Reading `request.headers` inside the tool executor**: rejected — no request exists there; the loop runs independently of the HTTP call that queued the turn, and only the carrier sees the request.
- **Persisting the headers on the session as an event**: rejected — one event per request would grow the log for data that only the next call needs, and it would make request headers durable state with no retention rule.
- **Per-instance transport rebuild with dynamic `requestInit`**: rejected — the MCP SDK fixes transport headers when the connection is created, and rebuilding a connection per call would cost more than the call.
- **Passing the context as tool arguments**: rejected — the model would see and could author the identity, and every tool schema would have to declare it.

## Consequences

- Identity, case, and any other caller context now reach the server on every call, so its authorization and audit see the real caller instead of the service account.
- The forwarded set is whatever the deployment maps; a header the caller sends but the mapping omits never leaves the process.
- `authorization` is in the same header bag, so a deployment that maps it forwards the caller's own credential to that server. That is the caller's decision, visible in config, not a code default.
- A server that reads `_meta` keys the mapping does not produce still runs as its service account, unchanged and silently — the config is the only place that says otherwise.
## Testing

`packages/mcp/mcp-client/tests/mcp-client.spec.ts` proves the wire request: a call with no provider registered sends no `_meta`, registering one makes the next call carry it, and a provider whose entries change between calls is re-read (per-call resolution, not registration-time capture). `packages/tenant/agent-http/tests/agent-http.spec.ts` proves the carrier enters the inbound headers — lowercased names, credential included — inside the scope it already serves. `packages/tenant/tenant-app/tests/mcp-meta.spec.ts` covers the provider: case-insensitive header matching, an absent mapped header omitted, no ambient request, and no configured mapping. All three branches of `entries()` are covered, and the tenant scope's shadowing/unwind behavior is asserted directly.
