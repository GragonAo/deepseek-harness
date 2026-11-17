# Agent Note: MCP servers mount at startup, never inside a turn

Status: implemented

English | [中文](2026-11-16-mcp-mounting-at-startup.zh.md)

## Problem

A conversation paid for its external MCP connection out of the request that opened it. The plugin mounted every effective server into `agent.ctx` on `agent/created`, and the session's first `agent/pre-step` blocked for up to `firstStepWaitMs` waiting for those mounts to settle; a registry write marked the sessions stale and the next step's reconcile was awaited under the same budget. That put a third-party endpoint's latency directly in front of the user's first token.

On a production cluster this stopped being a tuning problem. Cluster DNS was configured with `ndots:5`, and a four-dot service name therefore cost four extra NXDOMAIN round trips before the real lookup; with a dozen MCP hosts to resolve through a saturated libuv thread pool, resolution ran into tens of seconds. The OpenAI transport's connect deadline fired first, the request failed at the same cadence no matter how the stream timeout was configured, and the user watched a spinner that never produced text. Raising `timeoutMs` and `streamIdleTimeoutMs` changed nothing, because the deadline was in the connection phase rather than the stream. The requirement that follows is not a longer wait but the absence of one: a server that cannot be reached must be skipped, connections belong to startup and to the write that adds a server, and assembling a model request must never be where an MCP handshake happens.

## Decision

Mounting is split into two tiers, each placed in the widest scope whose lifetime matches who owns the row.

- **The system list mounts once, at plugin activation, into the plugin's own scope.** Activation starts the connections in the background and does not await them. The core tool registry resolves names nearest-scope-first, so those tools reach every session through the scope chain without a per-session mount, and the deployment holds one connection per server instead of one per agent.
- **A user's own rows mount into `agent.ctx` on `agent/created`**, in the background. The ambient user exists only while that agent is created, and a scope registration is what keeps the row invisible to another user's session. They mount under user-scoped names (`mountNameFor('user', …)`), so they cannot collide with a system row.

No step on the request path awaits an MCP endpoint, because nothing on that path starts one. A bounded first-step wait was added for the mount a session starts at creation and removed again once measurement showed a step's tool list is assembled before `agent/pre-step` runs, so the wait could never change that step's tools: [why the first message can miss the user tier](2026-11-17-first-message-tool-list-ordering.md).

A registry write re-mounts both tiers **immediately** — the write is the trigger, not a step boundary. `failOnStartupError` stays false in every mount, so an unreachable server is logged and left out; the client's own reconnect policy brings it in later without holding up anything. A mount that never came up is not recorded as mounted, so the next registry write retries it. A mount whose endpoint, headers, timeout, or concurrency changed is rebuilt; one whose fingerprint is unchanged is left alone.

A step-side budget under the old name `firstStepWaitMs` is gone. `toolCallTimeoutMs` takes its place in the tenant configuration: the per-tool-call fallback the mounts pass to the client, not a bound on how long a turn defers to a connection. A bounded wait (`firstMessageWaitMs`) was added back once, measured, and removed with the mechanism — a step's tools are assembled before the hook runs ([first-message ordering](2026-11-17-first-message-tool-list-ordering.md)).

Each mount publishes its outcome to the registry (`McpServerStore.reportMount`), so `mcp.effectiveServers` answers `mounted`, `failed` (with the reason), `disabled`, or `unknown` instead of inferring health from an enabled row. The report is process-local and never persisted, a retry replaces it, and a row that goes away has it cleared. Without it a configuration surface presents an unreachable endpoint as a working server, because an enabled row is all it can see — which is what a user adding a third-party MCP server actually experienced on the deployed build. The outcome is the connector's, not activation's: `mcp-client` publishes `mcp/client-state` (`up`, or `down` with the reason) and each mount subscribes before the mount settles, because `failOnStartupError` is false so that a third-party endpoint can never fail an agent's activation — the first build of this design reported a refused endpoint as `mounted` for exactly that reason, and a later reconnect flips the report back.

## Alternatives considered

**Raise the timeout.** The first response to the production failure was to set `timeoutMs` and `streamIdleTimeoutMs` to three minutes. It changed nothing: the failures kept their ten-second cadence, because the connection never completed, and a longer deadline only lengthens the wait when the endpoint is genuinely slow. A deadline is a bound on suffering, not a design.

**Keep per-agent mounting and shorten the wait.** Making `firstStepWaitMs` smaller trades a slow turn for a turn that frequently lacks the tools it was supposed to have. Both outcomes are the user paying for the mount.

**Keep the step-boundary reconcile and make it non-blocking.** This was the smallest change, and it was rejected on the requirement rather than the evidence: a server a user just saved still would not start connecting until their next prompt. The write is the moment of intent, so the write is the trigger.

**Hoist user rows into a per-user scope.** Not available: user identity rides an `AsyncLocalStorage` ambient, not a Cordis scope, so there is no lifetime-stable context to hold a user's mounts. Creating one would invent a second authority for the same fact.

**Pool connections across agents and keep mounting per agent.** Orthogonal to the wait and much larger: a shared connection needs a policy for what a tool call in one agent may observe about another, and it does not remove the handshake from the turn. The system tier gets the pooling benefit as a consequence of living in one scope, which is the whole cost of the row's ownership being deployment-wide.

## Consequences

**Bought.** A turn never waits on an MCP endpoint, so a slow or dead server costs one background attempt and one warning line. The system tier's connections are opened once per process instead of once per agent, and its tool definitions are stable for the host's lifetime, so the prompt prefix they occupy is reused across requests and sessions. Every session's first request already carries the system tools, and a server a user saves begins connecting at the moment they save it.

**Cost, removal.** Eager reconciliation can remove a tool while a turn streams. That surfaces as one failed tool call in that turn rather than as a user waiting on a write they already completed. This is the deliberate trade the previous design refused to make, and it is now the documented behavior.

**Cost, one client per system server.** Every session reaching a system server shares one client, so the row's headers have to be the same for every user, and its `toolConcurrency` is a deployment-wide ceiling rather than a per-agent one. A server needing a per-user endpoint or credential belongs in the user tier, which mounts per session.

**Cost, no step-side readiness.** A session whose own row is still connecting opens without that tool and gains it on a later request, costing one prefix invalidation at that point. Deferring the request until the mount lands is exactly what this change removes.

## Testing

`packages/tenant/mcp-external/tests/mcp-external.spec.ts` pins the two tiers and the absence of a turn-side wait: the system list mounts into the plugin scope at activation with no session present, a session with no rows of its own mounts nothing, another user's rows stay out of the first user's scope, a step boundary neither blocks on a hanging connector nor starts a mount, a registry write mounts, unmounts, retries, and reconnects the right server without a step, and disposal closes the tier. A mount publishes `mounted`, a refused endpoint publishes `failed` with its message, and removing the row forgets the report; `packages/host/apiproxy/tests/api-proxy-mcp.spec.ts` pins the wire view that carries it beside `mounted`. The suite replaces the earlier per-agent cases, which asserted the behavior this decision reverses.
