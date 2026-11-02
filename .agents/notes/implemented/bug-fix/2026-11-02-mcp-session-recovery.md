# Agent Note: Re-initialize an MCP session the server has forgotten

Status: implemented

English | [中文](2026-11-02-mcp-session-recovery.zh.md)

## Problem

A Streamable HTTP MCP server keeps its sessions in process memory and answers `404` to the `Mcp-Session-Id` it issued once that session is gone — after a redeploy, a restart, or an expiry. The specification defines that answer as "no session by that id; initialize again". The transport itself stays healthy: nothing closes, no `onclose` fires, and `client.request()` rejects with a `StreamableHTTPError` whose `code` is the status.

The connection supervisor only reacts to a lost transport, so that state was invisible to it. Every `tools/call` of the plugin kept going out under a session the server had forgotten, the server refused each one before dispatch, and the tools stayed broken for the life of the process — including for a harness whose tools were all proxied through one such server. The model in the affected session diagnosed the state correctly from the error text and asked the user to restart "the conversation", which cannot help: the MCP client is one plugin instance per configured server, owned by the Host process, not by a session.

## Decision

`src/session.ts` classifies one failed attempt with `isSessionLostSignal(error)`: true only for a `StreamableHTTPError` whose `code` is `404`. Only the transport's own answer counts — a JSON-RPC error the server chose for the tool says nothing about the session, and a 404 on a transport that never established one is a wrong endpoint.

`startConnection` exposes `recoverSession(stale)`. It closes the stale generation, which turns the state into the ordinary disconnect the supervisor already handles (reconnect with backoff, re-initialize, re-sync tools), and resolves with the next successfully connected generation. Waiters are bounded by `reconnect.maxDelayMs` and settle early when the policy gives up, when reconnection is disabled, or when the plugin is disposed. Concurrent recoveries share one reconnect; a call that asks about a generation already replaced receives the live one instead of starting a third.

`callToolWithinCap` spends at most one recovery per call: on a session-lost refusal it re-sends the same call on the recovered generation. The retry is safe for any tool, including a writer, because the server rejected the session before dispatch — the refused call never reached a tool. A second refusal is left to the reconnect policy rather than looped by one waiting call.

## Alternatives considered

**Treat the state as an ordinary tool failure and let the model retry.** Rejected: the retry cannot succeed. The stale id is held by the plugin instance, not by the turn, so every later call and every later turn fails identically until the Host restarts. The affected session did exactly this — nine calls and a `sleep` — and burned its whole budget on an unrecoverable error.

**Make the server stateless so no session exists.** Rejected for this package: the ICAC deployment could adopt it, but an MCP server is third-party here and the bridge must handle the sessions the specification defines, not only the ones a cooperating server chooses to stop using.

**Restart the Host when a session is refused.** Rejected: restarting a process to repair one connection drops every other tenant's in-flight work, and it is not something a plugin can do to its own host.

**Classify by matching the server's message text ("Session not found").** Rejected: message text is a server-specific string, and the status the specification reserves for this answer is already what the client receives. A server that answers a non-compliant `400` remains a manual restart, which is the current behavior.

**Re-initialize inside the transport.** Rejected: the SDK owns the transport's session id and `initialize`, the tool registry is registered per generation, and a transport that re-initializes behind the supervisor's back would leave the registered tool set describing a generation the supervisor never saw.

## Consequences

- A refused session now costs one reconnect (the configured backoff delay) plus one retry, and the model sees the tool's real result instead of an error it cannot fix.
- The retried call is the only one the model sees, so the transcript and the session log show one `tool/result` rather than a failure plus a success.
- A server that is genuinely misconfigured as a `404` endpoint now produces one recovery attempt before the call fails, and the reconnect loop then reports the misconfiguration it always did.
- Recovery inherits the reconnect policy: with `reconnect.enabled: false` a refused session still fails, after waiting out `maxDelayMs`.
- The recovery wait is bounded by `maxDelayMs` rather than `toolCallTimeoutMs`; a tool call can therefore block for up to that delay before reporting the server's refusal.
