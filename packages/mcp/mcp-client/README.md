# @deepseek-ai/dsh-mcp-client

English | [中文](README.zh.md)

MCP client bridge plugin: connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and registers their tools on `ctx.tools`, making them available to the model as native tools under server-qualified names (`mcp__<serverName>__<rawName>`).

## Usage

One plugin instance per MCP server in `cordis.yml`:

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'

- id: mcp-mining
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: mining
    transport: streamable-http
    url: http://127.0.0.1:8080/mcp
    toolConcurrency:
      policy: parallel
      mode: adaptive
      maxConcurrentCalls: 20
      recoveryQuietMs: 5000
      retryAttempts: 2
      retryTools: [explain_query, list_indexes]
      exclusiveTools: [create_index, drop_index, write_rows, update_rows, delete_rows]
```

The third entry is the shape for a third-party server whose annotations you cannot change or trust: every tool is declared concurrent so twenty queries can be in flight, while the five tools that write stay serial on the client side. Its `mode: adaptive` also lets the client find the load itself: it starts at twenty and halves that on every refusal, down to one call at a time, then adds one slot back per five seconds without a refusal. `retryAttempts: 2` re-sends a refused call, waiting a jittered 200 ms then 400 ms first — but only for a tool advertising `readOnlyHint: true` or named in `retryTools`, here the two read-only tools whose annotations are wrong. The five writing tools are never re-sent.

The model sees `mcp__github__create_issue`, `mcp__web__search`, … — the same server-qualified shape Claude Code and Codex use. HMR hot-swaps: editing the entry triggers disconnect + reconnect without process restart; an unchanged `serverName` reproduces identical tool names.

## Config

| Field | Transport | Required | Description |
|---|---|---|---|
| `transport` | both | yes | `"stdio"` or `"streamable-http"` |
| `serverName` | both | yes | Namespace for this server's model-facing tool names; `[A-Za-z0-9_-]{1,32}`, unique across live instances |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers (e.g. auth tokens) |
| `toolCallTimeoutMs` | both | no | Timeout per `callTool` invocation (default 60000) |
| `failOnStartupError` | both | no | Reject plugin activation when initial connection or tool synchronization fails (default `false`) |
| `reconnect.enabled` | both | no | Reconnect automatically after a lost connection (default `true`) |
| `reconnect.initialDelayMs` | both | no | First reconnect delay in ms; doubles per consecutive failed attempt (default 500) |
| `reconnect.maxDelayMs` | both | no | Backoff ceiling in ms; also the uptime after which the attempt budget resets (default 30000) |
| `reconnect.maxAttempts` | both | no | Consecutive failed attempts per outage before giving up for good (default 10) |
| `toolConcurrency.policy` | both | no | How this server's tools are classified for concurrent calls: `"annotations"`, `"parallel"`, or `"exclusive"` (default `"annotations"`) |
| `toolConcurrency.mode` | both | no | Whether the cap is the configured number (`"fixed"`) or a number learned from this server's refusals (`"adaptive"`) (default `"adaptive"`) |
| `toolConcurrency.maxConcurrentCalls` | both | no | Calls this one server may be handling at the same time; the starting cap in adaptive mode and its ceiling (default 10) |
| `toolConcurrency.exclusiveTools` | both | no | This server's raw tool names that never overlap another call, whatever `policy` says for the rest of its tools (default: none) |
| `toolConcurrency.retryTools` | both | no | This server's raw tool names that may be re-sent after a refusal, in addition to tools advertising `readOnlyHint: true` (default: none, so only read-only tools are ever retried) |
| `toolConcurrency.decreaseFactor` | both | no | Multiplier applied to the cap on each refused call in adaptive mode, greater than 0 and less than 1 (default 0.5) |
| `toolConcurrency.recoveryStep` | both | no | Slots added to the cap per quiet window in adaptive mode (default 1) |
| `toolConcurrency.recoveryQuietMs` | both | no | Time without a refusal before one recovery step, in ms (default 2000) |
| `toolConcurrency.countTimeouts` | both | no | Whether a call that hits `toolCallTimeoutMs` counts as a refusal (default `true`) |
| `toolConcurrency.retryAttempts` | both | no | Extra attempts per refused call, at most 5, and only for a tool that is read-only or named in `retryTools` (default 0) |
| `toolConcurrency.retryBaseDelayMs` | both | no | Delay before the first retry in ms; doubles per further attempt (default 200) |
| `toolConcurrency.retryJitterRatio` | both | no | Fraction of each retry delay that is randomized, from 0 to 1 (default 0.2) |

## Tool naming

Every MCP tool has two names: the raw MCP name (sent on the wire in `tools/call`) and the public name `mcp__<serverName>__<rawName>` registered on `ctx.tools`. Public names are normalized to the DeepSeek function-name contract (64 chars, `[A-Za-z0-9_-]`); when replacement or truncation changes the name, a deterministic 12-hex-char hash of `(serverName, rawName)` is appended so distinct tools never collapse into one name. Names are pure functions of `(serverName, rawName)` — connection order, re-syncs, and other servers never rename a tool.

- Two servers publishing the same raw name (e.g. `search`) coexist under their namespaces.
- A duplicate `serverName` across live instances fails the later plugin instance at load.
- A server listing the same tool name twice is rejected as an invalid tool list.
- A foreign registration squatting on this server's namespace rolls back the whole generation (never a partial set), with a loud error.

## Behavior

- On connect: plugin activation awaits `listTools()` and registers each tool via `ctx.tools.register()` under its public name before the composition starts its first turn. Initial connection, discovery, or registration failure is always logged; it rejects activation when `failOnStartupError` is true and otherwise activates with no tools.
- Listens for `notifications/tools/list_changed` → re-syncs; a fetch-phase failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation and leaves no tools from that server.
- Tool execute: `client.callTool({ name: rawName, arguments }, { signal })` with timeout + abort support—the public name is never sent to the server.
- Concurrency follows each tool's own MCP annotations: a tool advertising `readOnlyHint: true` or `idempotentHint: true` is declared safe to run beside other tool calls, everything else runs exclusively (one call at a time, whole harness). `toolConcurrency.policy` overrides that classification per server — `"parallel"` declares every tool of this server concurrent, `"exclusive"` declares none — for servers whose annotations are missing or wrong. Classification is per tool and ignores arguments.
- `toolConcurrency.exclusiveTools` names this server's raw tool names that must never overlap another call, independently of `policy` and `maxConcurrentCalls`: a listed tool is classified exclusive even when it advertises `readOnlyHint`, so one server can accept 20 concurrent calls while the five tools that write stay serial. Names are judged against the server's own `tools/list` during discovery — a name the server does not report fails that synchronization and reports the names it does, instead of serializing nothing in silence. A listed call runs alone for the whole assistant step, because that is what the loop's exclusive barrier does; a read-only call to another server in the same step therefore waits for it too, and `maxConcurrentCalls` only bounds the remaining calls.
- `toolConcurrency.retryTools` answers the separate question of which calls may be sent twice, and the two lists do not imply each other: `exclusiveTools` is about submission order, `retryTools` about repetition, and `policy` about whether calls may overlap at all. A read-only tool whose order matters belongs in both; a tool that writes belongs in neither. Names are judged the same way, so a `retryTools` typo fails that tool synchronization instead of quietly leaving the tool unrestried.
- Every `tools/call` to one server passes through that server's cap of `toolConcurrency.maxConcurrentCalls` in-flight requests. Calls over the cap wait in FIFO order instead of failing: the model asked for each of them, and the per-call timeout starts at the request, not at the queue, so waiting is not charged against `toolCallTimeoutMs`. The bound is per plugin instance, so a second server keeps its own budget. Disposal fails a call that is still waiting rather than leaving it pending.
- `toolConcurrency.mode` decides where that number comes from. `"fixed"` holds `maxConcurrentCalls` for the life of the connection, which is what a measured server wants. `"adaptive"` (the default) learns the number instead, for the usual case of a third-party server whose capacity is unknown and cannot be asked: it starts at `maxConcurrentCalls` and halves it (by `decreaseFactor`) on every refusal, down to one call at a time — never zero, so a refusal never stops calls being sent — and adds `recoveryStep` back once `recoveryQuietMs` have passed with no refusal. A static number cannot be right for a server nobody has measured: too high produces the refusals the learning then absorbs, too low wastes the parallelism the caller asked for, and the learned cap stays inside the configured bounds. A slot already granted is never taken away, so a drop only changes which waiting calls are admitted next. The learned cap lives in the plugin instance and is not persisted: a restart or an HMR reload starts again at `maxConcurrentCalls`, and each replica of a deployment learns its own budget.
- A refusal is read from the failure the client itself observes: HTTP 429 or any 5xx status, a closed connection, a refused or reset TCP connection, and — when `countTimeouts` is true — a call that hits `toolCallTimeoutMs`. A JSON-RPC error the server chose for the tool, a tool-level `isError` result, a caller cancellation, and a misconfiguration such as a missing command are not refusals and never change the cap.
- `toolConcurrency.retryAttempts` re-sends a refused call up to that many extra times, waiting `retryBaseDelayMs` doubling per attempt, each delay scaled by `retryJitterRatio` to spread a synchronized batch. That budget applies only to a tool whose own annotations declare `readOnlyHint: true` or that `retryTools` names: an empty `retryTools` retries only read-only tools, so a write is repeated only because a deployment said repeating it is safe — never because it was left out of a list. A tool outside the allow-list fails on its first refusal, and truthfully. Each attempt takes its own queue slot and its own `toolCallTimeoutMs` window, so neither the queue nor the backoff is charged to the call's timeout, and each refused attempt also lowers the adaptive cap. A call canceled while waiting for a retry reports the cancellation. Retry attempts are server-side requests the model never sees: the retried call still produces exactly one result.
- Canonical success is `{ content: JsonValue[], structuredContent? }`; complete JSON MCP blocks survive for programmatic callers. A supported advertised `outputSchema` validates `structuredContent`; unsupported schema vocabulary falls back to unconstrained `JsonValue`.
- Native/model rendering preserves MCP block order. Text-like runs join with newlines; resource links keep their name and URI as text; supported images become durable core image blocks only when `ctx.attachments` is mounted and the exact calling model route explicitly declares image input. The whole image batch is decoded and admitted before any member is saved. A malformed/refused image batch, audio, embedded resources, and unsupported blocks become explicit diagnostic text rather than disappearing.
- On disconnect/crash: the supervisor restarts the original server config with exponential backoff (`reconnect.initialDelayMs` doubling up to `reconnect.maxDelayMs`) and re-runs discovery on success — the recovered generation replaces the previous one, so tools neither duplicate nor leak. During the outage the last good generation stays registered; calls against it fail until recovery.
- Reconnection is budgeted per outage: after `reconnect.maxAttempts` consecutive failures the server's tools are unregistered and reconnection stops until an HMR reload or Host restart. A connection that survives past `maxDelayMs` resets the budget, so an occasionally-crashing server recovers indefinitely while a crash-looping one — even with briefly successful connects — still exhausts the cap instead of restarting forever.
- Reconnect states are user-visible in logs: reconnecting (warn, with attempt count and delay), recovered (info), final failure and disabled-loss (error). Disposal cancels any pending reconnect. With `reconnect.enabled: false`, a lost connection keeps tools registered but failing until a reload — the manual-recovery behavior.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register/unregister MCP tools |
| `ctx.attachments` | Optionally validate and persist image result batches before model projection |
| `ctx.llm` | Optionally prove the exact calling route explicitly supports image input |

## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, each advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. A successful re-sync — including the one after an automatic reconnect — replaces the generation; plugin disposal or an exhausted reconnect budget removes it.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the discovered tool set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. The execution-local canonical value always retains the complete JSON MCP blocks and optional structured content for programmatic and Code Mode callers. In Native context, supported image blocks are durably projected beside text in their original order after exact route-capability proof; Code Mode additionally ferries that settled rich projection through the outer `run_code` result without changing the canonical binding value. Refused images, audio, embedded resources, resource links, and unknown blocks remain visible as bounded text diagnostics, and MCP `isError` rejects the call before image persistence.

#### Token effect

Arguments, mapped text, and durable image references are retained until compaction. Inline MCP base64 stays only in the execution-local canonical value and is never copied into a session event; the provider reads verified bytes from the attachment store. Audio and embedded-resource payloads stay out of model context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Concurrent MCP tool calls

#### What the model sees

The concurrency classification is not model-visible: no schema field, prompt line, or result text carries it. What the model observes is timing and ordering. A tool the policy classifies as concurrent overlaps the other tool calls of the same assistant turn instead of queueing behind them, so a turn that asks one server several read-only questions returns them together rather than one round trip apart. A tool classified exclusive runs alone, and a call beyond this server's cap waits for a free slot instead of failing, so a large batch finishes in waves without any call being reported as an error. A tool named in `toolConcurrency.exclusiveTools` is always in that exclusive case: every other call of the same turn waits for it, including calls to other servers. Results arrive in the order the model requested them whatever order the server answers in. The learned cap changes only how many calls are in flight and how long the rest wait: a batch against a server that refuses calls takes longer as the cap drops and speeds up again as it recovers. A refused call the allow-list covers is retried, so the model sees one result where the server refused one request and no error at all; a refused call outside the allow-list reports the server's refusal on its first attempt.

#### Token effect

Zero direct: neither the annotations the classification reads nor the cap appears in a tool definition, an argument, or a result. Indirect: the same calls produce the same tokens, ordered the same way; concurrency only shortens the wall-clock time before those results become available.

#### KV Cache effect

Append-only, and independent of the classification. Overlapping calls commit their results in model order rather than completion order, so the request prefix of the next turn is the same sequence the serial case produced and reuse survives. Changing `toolConcurrency.policy`, `maxConcurrentCalls`, `exclusiveTools`, `retryTools`, `mode`, or any adaptive or retry parameter reclassifies calls without changing any tool definition token, so it never invalidates a reusable prefix. A retried call adds no provider request of its own: its single result takes the position the model asked for.

## Known Limitations and Deferred Work

- **Tools are the only bridged MCP capability** — Resources and Prompts have no harness consumer and are deferred.
- **Startup timeout is inherited from the MCP SDK** — DSH does not yet expose a connection/discovery timeout. Each initialize or paginated `tools/list` request uses the SDK's 60-second default, so an unresponsive server or cursor chain can delay both activation and teardown while the initial synchronization settles.
- **Reconnect triggers on transport close** — a crashed stdio child fires it; Streamable HTTP failures surface per request and through the SDK transport's own SSE-stream recovery, so an unreachable HTTP server is retried per call rather than respawned by the supervisor.
- **Image is the only durable rich-result bridge** — PNG, JPEG, WebP, and GIF can enter Native context after exact capability proof. Audio and embedded-resource payloads remain execution-local with explicit diagnostics, while resource links preserve only their name and URI as text.
- **Unsupported MCP output schemas are not enforced** — `structuredContent` falls back to `JsonValue` when the advertised schema uses vocabulary outside the harness subset.
- **Adaptive mode learns per plugin instance** — the learned cap is in-memory state: it is not persisted, not logged, and not shared between replicas of the same deployment or between two hosts reaching the same server, so an aggregate of independent instances can still exceed what the server tolerates. Coordinated limiting across replicas is out of scope; the fallback is a lower `maxConcurrentCalls` or `mode: "fixed"`.
- **A timeout counts as a refusal by default** — with `countTimeouts: true` a genuinely slow server is downgraded as if it were overloaded, so a batch against it may end up serialized for no benefit. Raise `toolCallTimeoutMs`, lower `recoveryQuietMs`, or set `countTimeouts: false` for a server whose latency is expected.
- **The retry allow-list trusts the server's `readOnlyHint`** — that annotation is server-supplied wire data, and a server that mislabels a writing tool as read-only has its refused calls repeated. The decision has no inverse per tool: a deployment that distrusts those annotations for one server can only set `retryAttempts: 0` there, which disables the retry budget for its listed tools too.
