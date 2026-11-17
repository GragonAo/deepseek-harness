# Agent Note: A session's first message can miss user-tier MCP tools, and no step-side wait fixes it

Status: implemented

English | [中文](2026-11-17-first-message-tool-list-ordering.zh.md)

## Problem

[Mounting at startup](2026-11-16-mcp-mounting-at-startup.md) moved every MCP handshake off the request path: the system tier connects during plugin activation, a user's own rows connect when the session is created, and no step waits for either. Field measurement afterwards showed one behaviour that looked like a regression and was not one: a client that creates a session and sends its first message in the same action — `session.create` + `session.prompt` back to back, or a web client that opens a chat and types into it — gets a first message whose tool list holds the system tier and none of the user's own servers. The model then reports that the user's tool is not mounted, which is the exact failure the two-tier design exists to prevent.

The mount is not slow: on the tenant host a fresh session's user tier settles about 80 ms after `agent/created`, measured three times in a row on a warm host and unchanged after a host restart.

## What was measured

`agent-loop`'s `preStep` calls `systemPrompt.assemble()` (which resolves the tool list) and only then dispatches the `agent/pre-step` waterfall. A plugin's earliest hook therefore runs *after* the tools for that step are already fixed. Instrumenting the mount path confirmed the rest: the pass had already finished when the step ran (its book held both mount names, with 1.4 s of an experimental 1.5 s budget still unspent), and the step still sent the old tool list.

Two consequences follow, and together they decide this note:

- A wait inside `agent/pre-step` cannot add a tool to the step it runs in. The tools it could add appear on the next step — which is what a pause of a few seconds demonstrates, and why "ask again" always works.
- The only way a first message sees a freshly mounted server is for the mount to complete before that message's step assembles its tools, i.e. before the prompt, not during it.

A bounded wait inside `agent/pre-step` was implemented, shipped to a verification cluster, measured, and removed: it cost a session's opening up to its whole budget on a dead row (1500 ms by default) while never once changing the outcome for the case it targeted. A mechanism that only pays cost is worse than a documented ordering fact.

## Decision

No step waits for an MCP endpoint, and the plugin ships no knob to make one wait.

- The user tier mounts at `agent/created` and at every registry write, so a mount has started before any prompt a person can type and settles long before their first keystroke.
- A server whose connect completes later joins mid-conversation, on the next mount pass, without holding up any step.
- The residual race is stated in the package README and the module JSDoc rather than papered over: a first message sent inside the mount's first hundred milliseconds misses the user tier, and that session's second message has it.

## Alternatives considered

**Wait in `agent/pre-step` (`firstMessageWaitMs`, 1500 ms default).** Built, shipped to the cluster, measured at both a healthy and a dead endpoint, then removed: it cannot affect the step's own tool list, so it bought nothing and delayed every opening step in a session holding a bad row.

**Assemble tools after the `agent/pre-step` waterfall.** That is an `agent-loop` change, not a plugin one, and it would make the tool list depend on whatever a listener does — including starting network work — which is the coupling the previous note removed. It is the correct fix only if a future caller cannot tolerate the residual race at all.

**Hold the message until the mount settles, from `agent/inbox/inserted`.** That event is a notification: dispatch does not await it, so it cannot delay the turn. Pausing the agent instead would fight the loop's own status machine.

**Wait in the `session.prompt` RPC.** It is the one seam that runs before assembly, so it would work; it also needs a cross-package readiness service (`apiproxy` asking an MCP plugin about a session's mounts) for a race that human typing latency already covers — 80 ms of mount against hundreds of milliseconds of keystrokes. Deferred until a caller demonstrably batches create and prompt faster than that.

**Mount user rows once in a per-user scope.** Still unavailable for the reason the previous note gives: user identity is an `AsyncLocalStorage` ambient, not a Cordis scope.

## Consequences

**Bought.** No MCP endpoint can delay a step, ever, and the cost of a dead row is one background attempt plus a warning line in the session that holds it.

**Accepted.** A brand-new session whose very first message arrives within the mount's first hundred milliseconds has no user-tier tools in that message. The session's second message does. Restarting the host does not widen this window.

**Kept from the attempt.** Two facts from building it are worth keeping in the tests and the fixture: a scoped event is dispatched by its scope key, so an `agent/pre-step` listener must be registered on the session's own scope (`agent.ctx`, whose key is the agent) and not on the host context, and the test fixture therefore scopes its agent with `createScope(ctx, agent)`.

## Testing

`packages/tenant/mcp-external/tests/mcp-external.spec.ts` pins the behaviour that remains: a step boundary neither blocks on a connector that never answers nor starts a mount of its own, a session's own rows mount into that session's scope, and a registry write re-mounts a live session. The two tests for the removed bounded wait are gone with the mechanism.
