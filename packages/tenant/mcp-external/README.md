# @deepseek-ai/dsh-mcp-external

Mounts the external MCP servers a session is entitled to into that session's agent — at session start, and again whenever the registry changes underneath a running session.

The registry ([`dsh-mcp-servers`](../../mcp/mcp-servers/README.md)) says *what* a user may reach; this plugin decides *when* it reaches them and how a stored row becomes a live tool namespace. It provides nothing itself: there is no service on `ctx`, no RPC method, and no setting. Its whole surface is the mount it performs.

## Why per agent, not per host

Each agent gets its own [`dsh-mcp-client`](../../mcp/mcp-client/README.md) instance in `agent.ctx`, one per effective server, under the mount name the registry derived. That scope choice is what makes the feature additive: the core tool registry already resolves names nearest-scope-first, so a server mounted in an agent's scope is visible to that agent and to nobody else, and no part of the shared host context has to learn about tenants or users.

It also fixes the failure mode. A server that refuses to start is logged and skipped (`failOnStartupError: false`); the session still opens with the servers that did work, and with the base tools. One unreachable third-party endpoint never costs a user their chat.

## Lifecycle

1. `agent/created` — resolve the caller's user from the ambient scope, read the effective set, and mount every server into `agent.ctx`. Mounts run in parallel; each has its own failure path.
2. `agent/pre-step` (first step) — wait up to `firstStepWaitMs` for those mounts to settle, so the turn that opens a session sees the external tools instead of racing them.
3. `agent/pre-step` (any step after a registry write) — reconcile: connect what is new, reconnect what changed, disconnect what is gone, and leave the rest alone. The step's request is assembled after this, so it already carries the new tool list.
4. `agent/disposed` — drop the session from the tracker; its mounts are scope registrations and go with the agent.

The wait is honest about its budget: whatever has not settled by then is left running, and the turn proceeds without it. `/mcp`-style inspection of a half-mounted server is worse than a turn that starts a second late.

## Hot reload

Registering, editing, disabling, or removing a server takes effect in the **next step of every running session**, with no restart and no need to open a new chat. `McpServerStore.subscribe` fires after each durable write; the plugin marks every session it tracks as stale, and the next `agent/pre-step` reconciles before the request is built.

Two deliberate choices make that safe rather than merely fast:

- **Anchored to the step boundary, not to the write.** A tool must not vanish from under a tool call the model is already streaming, so a step in flight keeps the tool list it started with and the change lands on the next one.
- **Fingerprint, not name.** A mount is rebuilt only when what it depends on changed — endpoint, headers, timeout, concurrency. Editing an unrelated server does not disturb it, and adding a second server does not reconnect the first.

The cost is one prompt-prefix invalidation on the step that carries a change (the tool list is part of the prefix); the alternative — a tool list that is never refreshed — is a session that cannot use what the user just configured.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-mcp-external'
  config:
    firstStepWaitMs: 5000      # how long the first pre-step waits for mounts
    maxServersPerAgent: 16     # cap on servers mounted into one agent
    toolCallTimeoutMs: 60000   # default per-tool-call timeout when a row sets none
```

Saving a server reaches a running session at its next step; the reconcile described above is what carries it, and a step already streaming keeps the list it started with.

## Model Experience

Indirectly, through dsh-mcp-client, which this plugin mounts per server inside the agent scope.

#### KV Cache effect

The tool definitions sit in the prompt prefix, so every step that carries a mount change re-prefixes once. Steps with no change reuse the prefix, and tool results cost nothing beyond their size.

## Known Limitations and Deferred Work

- **No mid-step swap.** A change lands at the next step boundary; a tool the model is already calling is never pulled out from under it. The last step of a turn therefore runs on the previous list.
- **A remount is a full reconnect.** The client has no in-place way to move to a different endpoint or credential, so an edit costs one handshake and one tool sync. Editing a server a turn is actively using means that turn's later steps see a fresh, empty-then-refilled tool list.
- **One connection per agent per server.** Ten agents of one user means ten connections to the same endpoint. Pooling across agents is deferred; it needs a policy for what a tool call in one agent may observe about another.
- **A mount that failed is retried only by the next registry write.** A server that was unreachable at session start is not retried on every step — that would put a network timeout in front of every turn. Save it again (or touch any row) to retry.
- **`toolConcurrency` is per server, per client instance.** `maxConcurrentCalls` gates calls from one agent, not from the whole deployment — a limit on an upstream service has to account for the number of agents.
- **A user cannot disable a system server.** Both lists are additive only.
