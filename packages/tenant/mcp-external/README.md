# @deepseek-ai/dsh-mcp-external

Mounts the external MCP servers a deployment and a user are entitled to, so a session has them from its first request without any request waiting for a connection.

The registry ([`dsh-mcp-servers`](../../mcp/mcp-servers/README.md)) says *what* may be reached; this plugin decides *when* it is reached and how a stored row becomes a live tool namespace. It provides nothing itself: no service on `ctx`, no RPC method, no setting. Its whole surface is the mount it performs.

## Two tiers, and why

A server is mounted in the widest scope whose lifetime matches who owns it.

- **The system list is deployment-wide, so it mounts once, at plugin activation, in the plugin's own scope.** The core tool registry resolves names nearest-scope-first, so those tools reach every session without a per-session mount, and the deployment holds one connection per server instead of one per agent.
- **A user's own rows belong to one user, so they mount into `agent.ctx` on `agent/created`.** The ambient user exists only while that agent is created, and a scope registration is what stops another user's session from seeing the row. They mount under user-scoped names, so they can never collide with a system row.

The failure path is the same in both tiers and it is why this design is safe to run eagerly: a server that cannot be reached is logged and left out (`failOnStartupError: false`). A session opens with whatever mounted, plus the base tools. One unreachable third-party endpoint never costs a user their chat.

## Lifecycle

1. **Plugin activation** — the system tier starts connecting in the background. Activation does not await it, so a slow registry cannot delay the host.
2. **`agent/created`** — the session's own rows mount into `agent.ctx` in the background.
3. **Registry write** — both tiers re-mount at once, not at a step boundary.
4. **`agent/disposed`** — the session stops being tracked; its mounts are scope registrations and go with the agent.
5. **Plugin disposal** — the system tier's mounts are closed.

No step waits — not even the first. The mount starts at session creation and settles in about 80 ms on this deployment, so the message a person types afterwards has the tools; a tool that connects later arrives mid-conversation, and a tool removed mid-turn surfaces as one failed call. One race is left open by the loop's ordering: a step's tool list is assembled *before* the `agent/pre-step` waterfall runs, so a client that creates a session and sends its first message inside those first hundred milliseconds loses the user-tier tools for that one message and sees them from the second. Nothing a listener can do closes that gap, which is why this plugin starts the mount at creation and holds nothing.

## What a slow or dead server costs

One background connection attempt and one warning line. The client keeps retrying on its own reconnect policy, so a server that comes up later joins without holding up anything, and `maxServersPerAgent` bounds how many rows either tier contributes to a session's tool list. A dead endpoint costs one background attempt and a warning line, in the session that holds the bad row, and never delays a step.

Each attempt publishes its outcome to the registry through `reportMount`, so a configuration surface reads `mounted` or `failed` (with the reason) rather than inferring health from an enabled row. The outcome comes from the connector, not from activation: `failOnStartupError` is false, so a refused endpoint still activates, and a mount that reported nothing would look healthy. The mount therefore subscribes to `mcp/client-state` before the mount settles, and a later reconnect flips the report back to `mounted`. The report is forgotten when the row goes away.

## Hot reload

Registering, editing, disabling, or removing a server takes effect **immediately**, with no restart and no need to reopen a chat. `McpServerStore.subscribe` fires after each durable write and both tiers reconcile on the spot, so a server a user just added starts connecting at the moment they saved it rather than at their next prompt.

Two deliberate choices:

- **Eager, not step-anchored.** The earlier design deferred the reconcile to the next step boundary so a tool could never vanish from under a streaming tool call. That safety cost the user a wait on the write they had already made, which is the cost this design removes: a tool removed mid-turn now surfaces as one failed call instead.
- **Fingerprint, not name.** A mount is rebuilt only when what it depends on changed — endpoint, headers, timeout, concurrency. Editing an unrelated server does not disturb it, and adding a second server does not reconnect the first.

The cost of a change is one prompt-prefix invalidation per active session; the alternative, a tool list that is never refreshed, is a session that cannot use what the user just configured.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-mcp-external'
  config:
    maxServersPerAgent: 16     # cap on the servers either tier contributes to one session
    toolCallTimeoutMs: 60000   # default per-tool-call timeout when a row sets none
```

## Model Experience

Indirectly, through [`dsh-mcp-client`](../../mcp/mcp-client/README.md), which this plugin mounts per server, so the system tier's tools are in every session's tool list from the first request and a user's own tools appear once their mount completes.

#### KV Cache effect

The system tool definitions are stable for the lifetime of the host, so their part of the prompt prefix is reused across requests and sessions. A registry write re-prefixes each active session once. A session whose own row is still connecting gains that tool on a later request and re-prefixes once at that point.

## Known Limitations and Deferred Work

- **A registry write can land mid-turn.** Eager re-mounting is what makes a newly added server connect immediately; in exchange, a removal during a streaming turn surfaces as one failed tool call rather than being deferred to the next step.
- **A remount is a full reconnect.** The client has no in-place way to move to a different endpoint or credential, so an edit costs one handshake and one tool sync.
- **One connection serves the whole system tier.** Every credential a system server needs has to be the same for every session, because that is a single client. A per-user endpoint or a per-user credential belongs in the user tier.
- **A mount that never came up is retried by the next registry write**, not on a timer: the client's own reconnect handles transient drops, and re-saving a row (or touching any row) retries one that never connected at all.
- **`toolConcurrency` follows the client instance.** For a system server that is one client shared by the deployment, so `maxConcurrentCalls` is a deployment-wide ceiling; for a user's own server it is per session.
- **A user cannot disable a system server.** Both lists are additive only.
