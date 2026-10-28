# Agent Note: MCP structured results reach the model as text

Status: implemented

English | [中文](2026-10-26-mcp-structured-content-model-visible.zh.md)

## Problem

A tool result that carried `structuredContent` reached the model as whatever placeholder its `content` blocks happened to hold — for the server this was written against, the literal line `result in structuredContent` — with the payload itself absent from the request. MCP splits a result in two: `content` blocks for clients that render text, and `structuredContent` for clients that want the value programmatically. The bridge preserved both in the canonical value, but its Native projection built the model's text from `content` alone, so a server answering with data plus a placeholder lost the data at the one place the model reads.

The failure is silent. The call succeeds, the model receives a well-formed result, and the only symptom is an answer reporting that the data lives somewhere the model cannot see.

## Decision

`createOutput().render` projects the content blocks and, when the result carries `structuredContent`, appends that value's compact JSON serialization on a new line. Three details carry the decision:

- **The append is skipped when the projected text already contains the serialization.** The MCP specification asks a server that populates `structuredContent` to also inline the JSON as a text block for clients that read only text; those servers keep the text they sent, so the payload appears once.
- **An empty `content` array renders as the serialization alone**, rather than as a no-content placeholder followed by data.
- **The canonical value is unchanged.** Programmatic and Code Mode callers still receive `content` and `structuredContent` as separate fields; only the Native text projection gains the serialization.

## Alternatives considered

- **Require servers to inline the serialization in `content`** — rejected: a deployment cannot rewrite the server it is given, the placeholder-plus-structured-payload response is legal MCP, and a harness that only works against conforming servers reproduces this defect for every deployment whose server is written the other way.
- **Render `structuredContent` in place of the content text** — rejected: it would drop the diagnostics the projection adds for refused images, audio, embedded resources, resource links, and unsupported blocks, and would discard any human-readable text the server did send alongside its data.
- **Add a per-server configuration switch for surfacing structured content** — rejected: visibility of a tool's own result is not a deployment choice a caller can make correctly without auditing every server's response format and every model task; nothing in the deployment needed the text-only behavior.
- **Bound or truncate the appended serialization** — rejected: no evidence supports a threshold, and a silent truncation would hand the model JSON that parses into something other than what the server returned. The unbounded cost is recorded as a Known Limitation instead.

## Consequences

A server that answers through the structured channel now contributes its payload to the model's context, and the placeholder-only case — total data loss for the model — is gone. Two costs follow. Results reach the model with more text whenever a server populates `structuredContent`, including servers that already inline the JSON; the `includes` guard prevents a doubled payload but cannot shrink the one copy. And the append is unbounded, so a server returning a large structured value spends those tokens on every later request of the session — a bound would have to come from the server, since the projection has no truncation setting.

The projection stays a pure function of the canonical value, so the value, the session event, and the model's text still derive from one source, and nothing new becomes model-visible that is not already logged.

## Testing

`tests/mcp-client.spec.ts` covers the three branches through the registry executor: placeholder text plus `structuredContent` appends the serialization, an empty `content` array renders the serialization alone, and an inlined serialization is not repeated. Existing tests that assert plain text results, empty results, and diagnostic placeholders are unchanged, which is what proves the projection still leaves results without `structuredContent` alone.