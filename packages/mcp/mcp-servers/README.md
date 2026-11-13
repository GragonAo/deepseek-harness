# @deepseek-ai/dsh-mcp-servers

English | [中文](README.zh.md)

The external MCP server registry: what an administrator or a user may store for a third-party MCP endpoint, and how two registers merge into the set one session mounts.

This package is the contract and the rules, not the medium. `McpServerStore` is an abstract `Service` on `ctx.mcpServers`; a provider ([`dsh-mcp-servers-postgres`](../mcp-servers-postgres/README.md)) implements five primitives — load and replace each register, and report the system revision — while every rule that decides what may be stored lives here, so a second provider cannot weaken validation by accident.

Only Streamable HTTP endpoints are representable. A `stdio` server would mean starting a process on the host, which is exactly the capability a configuration surface must not hand out; the parser rejects the fields that would express it (`command`, `args`, `cwd`, `env`, `transport`).

## Two registers, one shape

- **system** — the deployment-wide list an administrator owns. Mounted under its own `serverName`.
- **user** — one list per user. Mounted under `u_<sha256(owner)[0:8]>__<serverName>`, which keeps two users' identically named servers apart and makes the owner visible in a tool name.

`effectiveServers(system, mine, userId)` is the merge a session consumes: every enabled system row followed by every enabled row that user owns, each carrying `origin`, `ownerId` and the `mountName` it mounts under. Disabled rows are dropped at merge time rather than at mount time, so the list a caller reads is exactly what a session gets.

## Validation

`parseServerRecord(raw, where, { allowPrivateHosts })` is the single gate. It normalises headers to an empty map, clamps `timeoutMs` to 1…600000, keeps `descr` under 500 characters, and refuses a host that is loopback, a private range, carrier-grade NAT, link-local, multicast/reserved, or a cloud metadata endpoint.

`allowPrivateHosts` is one policy for both registers, defaulting to allowed: whoever configures a server is the one who will use it, and an intranet endpoint is as normal for a self-hosted user server as for an administrator's. An operator who needs public-only endpoints sets it to false, and both registers obey — so a connectivity test can never pass an address the save then refuses.

This is a **static** host check. A hostname that resolves to a private address is not caught here; re-checking at connect time is deferred work, listed under Known Limitations below.

## Probing a draft row

`probeMcpServer(url, headers, { allowPrivateHosts, timeoutMs })` completes one MCP handshake (initialize → `notifications/initialized` → `tools/list`, following up to five cursors) and reports `{ ok, toolsSupported, toolCount, latencyMs, error }`. It registers nothing, imports no tools, and reads a reply framed either as JSON or as an event-stream `data:` frame.

A failed connection is an answer (`ok: false`), not an exception. Only a refused address throws, because that is a policy refusal rather than something the endpoint said. `assertProbeAddress` is exported for callers that want to check an address before any network work.

## Model Experience

Indirectly, through dsh-mcp-external, which mounts these rows and hands them to dsh-mcp-client.

#### KV Cache effect

No direct cost. A registry write changes the tool list that the next step of every running session assembles, and the one-time prefix invalidation that follows is described by `dsh-mcp-external`.

## Known Limitations and Deferred Work

- **Static host checking only.** `isBlockedHost` matches literals textually; a DNS name resolving to a private address passes. Re-resolving at connect time (and refusing the connection) is deferred.
- **No per-user disable list.** A user may add their own servers and may not turn off a system one. That keeps "what does this user get" answerable from two lists instead of three.
- **Headers are stored in plaintext.** They must be replayed verbatim to the endpoint, so they cannot be hashed; redaction is a presentation rule (views expose header *names* only) rather than a storage one.
- **Revision guards the system register only.** A user register has one writer, so last-write-wins is correct there and `expectedRevision` is ignored for it.
- **Quotas are per store, not per operation.** `maxSystemServers` / `maxUserServers` are enforced on write; nothing reclaims space when a user is deleted.
