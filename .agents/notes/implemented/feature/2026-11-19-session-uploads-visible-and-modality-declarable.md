# Agent Note: The session uploads directory is model-visible every turn, and a route may declare image input

Status: implemented

English | [中文](2026-11-19-session-uploads-visible-and-modality-declarable.zh.md)

## Problem

A business frontend attached a document to a tenant session by uploading it into that session's directory (`uploads/`, written by the `tenant-fs-http` byte channel) and then sending a prompt whose text names no file. Nothing told the model what had arrived. The model's only file input is the directory itself, so a session that received `uploads/供述材料.pdf` answered as though the turn carried no attachment, and the user's first instruction in that conversation was to explain their own upload out of band. Uploading a photograph was worse: the model could reach it only through `read_image`, which refuses before the request when the route does not declare image input — and a route registered in the tenant model registry had no way to declare anything, because the registry's model records carried no modality field at all and model discovery dropped the modality a listing discloses.

The deployment's own remedy, a `tool-vision` tool with a separately configured vision endpoint, was built and then removed: it added a second model configuration to maintain and a tool the model had to choose correctly, for a capability the built-in path already has.

## Decision

**The uploads directory is read on every assembly and contributed as dynamic runtime context.** `@deepseek-ai/dsh-session-uploads` listens on `system-prompt/assemble`, lists the session's uploads directory through `ctx.fs`, and appends one entry named `context:session-uploads` to the assembly's contexts. The session log therefore records the snapshot the model saw, and a later assembly replaces it — the same "model-visible ⟺ logged" arrangement every other runtime-context contributor uses.

**The directory is addressed relative to the session directory the provider serves.** The listener resolves `uploads` with the session's own `cwd`, so `fs-container` answers `/sessions/<session id>/uploads` from the initiator the loop already establishes, and no deployment configures a host path. `directory` and `maxEntries` are validated `Config` fields (`uploads`, `40`); a name that could escape the session directory, or a bound that is not a positive integer, fails at load.

**The inventory is skipped, not faked, when there is nothing to read.** An absent directory, a path that is not a directory, an assembly with no session, and an `FsError` all contribute the empty string, which contributes no context section at all; any other failure propagates, so a broken provider is reported rather than presented as "no files". A session that never received a file pays no tokens and no cache change.

**A model declares its own request modalities, at the registry as at the route.** `LlmStoredModel.inputModalities` and `LlmDiscoveredModel.inputModalities` accept `text`/`image`; the value is validated where it is stored (a durable record), detached into the pi-ai `Model.input` when present, and left absent otherwise so the installed catalog and the route's `defaultInput` keep resolving as before. Discovery reads the OpenRouter spelling `architecture.input_modalities` and the top-level variant, dropping modalities this build cannot serve instead of failing the entry. This extends `[[2026-08-12-pi-ai-route-default-input-modalities]]` — the chain itself is unchanged; what is new is that a stored registry row and a listing disclosure can now feed it.

The tenant app mounts `session-uploads` in its spine by default, beside `tool-fs` and before `agent-instructions`.

## Alternatives considered

- **Name the files in the user turn.** The business side knows what it uploaded. Rejected because every caller would have to keep string-building a file list into its prompt, the list goes stale as the model writes into the directory, and the harness would still be unable to answer "what is in this session" for a turn written by anyone else.
- **List the directory once, on the first turn.** Cheaper by one `listDir` per assembly. Rejected because an upload that arrives mid-conversation — the ordinary case for "here is another file, compare it" — would be invisible, and the model has no way to ask again.
- **A session event per upload.** The writer is outside the harness, so the event would either be a second write path the byte channel must maintain or an inference this plugin makes from a directory it already lists. The directory is the record; the snapshot states what was in it.
- **Keep the configured vision tool.** Works for a deployment that names one vision endpoint, and needs no modality declaration. Rejected because it makes the model pick a second, differently-behaving read path, duplicates credentials and model selection beside the registry the platform already exposes to users, and does nothing for the ordinary image case the built-in path handles once the route declares what it accepts.
- **Default a new registry model to `[text, image]`.** Rejected for the reason the route-level note gives: over-claiming admits an image the provider rejects mid-turn, after the message is durably committed, which poisons the session. Under-claiming refuses with a message naming the model and the remedy.

## Consequences

Every assembly pays one directory read and one `stat` per session that has uploads; a session without the directory pays a failed `stat` and nothing else.

The inventory is a snapshot, not an arrival record: a file that lands between two assemblies appears in the next one with no event saying when it arrived, and a file name containing both `{{` and a later `}}` fails that assembly because context text is interpolated for prompt variables before it reaches the model. Both are recorded as the package's Known Limitations.

Declaring modalities is now the deployment's job for any model whose registry record or listing carries none — the `dmxapi` vision models on the tenant host included. Until a record declares `image`, `read_image` still refuses before the request with `does not declare image input`, which is the correct refusal and now has a documented remedy in the model's own registry row.

## Testing

`packages/context/session-uploads/tests/uploads.spec.ts` composes the real `SessionStore`, `SystemPrompt`, `AgentRegistry`, and `LocalFileSystem` over a temporary workspace, then assembles prompts and reads the contributed runtime context: a session with an upload lists it, a session without the directory contributes nothing, a file in place of the directory contributes nothing, an assembly with no agent contributes nothing, a configured directory and bound are honored, a file uploaded between two assemblies appears in the second, an `FsError` yields no inventory while an unexpected error propagates, and disposing the plugin fiber removes the contribution. `tests/listing.spec.ts` pins the rendered text, the binary-unit sizes, and the truncation count. `packages/tenant/tenant-app/tests/app.spec.ts` asserts the spine row is enabled and takes the plugin's defaults.

The modality field is covered in `packages/llm/llm/tests/provider-store.spec.ts` (spelling and empty-list refusal), `packages/llm/llm-pi-ai/tests/discovery.spec.ts` (both listing spellings, unknown modalities dropped), and `packages/llm/llm-pi-ai/tests/tenant-registry.spec.ts` (a declared list reaches the pi-ai model, an undeclared one keeps the catalog's).
