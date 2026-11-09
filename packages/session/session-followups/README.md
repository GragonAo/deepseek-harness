# @deepseek-ai/dsh-session-followups

English | [中文](README.zh.md)

Post-answer follow-up suggestions as a logged session fact. When a top-level turn completes, this plugin asks an auxiliary model which few questions the user is most likely to ask next, and records the accepted ones as a log-only `followup/suggested` event. A business surface folds that event into the turn it already renders, so follow-up chips cost the main conversation prompt nothing, survive reload, and can be re-rendered from the log alone.

The generator is a Cordis function plugin, not a service: it owns no capability any other plugin consumes, and it contributes only session events.

## Event contract

Two log-only events, both outside derived model history and neither a `SurfaceEventType`:

| Event | Payload | Purpose |
|---|---|---|
| `followup/llm-request` | `turn`, `route`, `system`, `messages`, `maxTokens` | The exact auxiliary request, appended before dispatch. |
| `followup/suggested` | `turn`, `questions` | The accepted questions, trimmed, non-empty, unique, in model order. |

`followup/llm-request` precedes the dispatch that it describes, so a logged suggestion is always reconstructable from the log (see [Model-visible ⟺ logged](../../../AGENTS.md#conventions)). A turn carries at most one batch: the generator returns early when the log already holds `followup/suggested` for that turn. Both events are appended in the same task that ends the turn.

## When it runs

The plugin listens to `session/event` and starts a detached run when a `turn/end` event reports `reason.kind === 'completed'`. It skips:

- A turn in a delegated child session (`header.parentSession` set, or `header.origin === 'subagent'`): nobody reads that transcript, so a suggestion call would be wasted.
- A turn whose final answer is shorter than `minAnswerBytes`: an acknowledgement has no follow-up worth asking.
- A turn whose accepted batch already exists.
- A turn whose log holds no request route yet, when no explicit `provider`/`model` pair is configured.

The run starts on the next microtask, because the session is still publishing the `turn/end` append and cannot be appended re-entrantly. Suggestions are therefore recorded after the turn's commit, never inside it.

## Route and failure contract

`provider` and `model` are optional, but must be supplied together. Without that pair the generator uses the provider/model route of the session's last logged `request/header`, which is the model that produced the answer. Timeout and plugin disposal share one abort signal: `timeoutMs` bounds the call, and disposing the plugin aborts every in-flight run and waits for it to settle before the plugin's effect resolves.

Any failure — no route, transport error, non-`stop` finish reason, a reply containing a tool call, an unparseable reply — leaves the turn without suggestions and logs `ctx.logger.warn`. Nothing propagates into the loop: a suggestion is an optional extra, never a reason to fail a completed turn.

The final framed user prompt is measured against `maxInputBytes` before dispatch. The answer is the only unbounded field, so it is bisected to the longest prefix that fits, with an ellipsis marking the cut; the question and tool list are never shortened. A budget too small for the framing alone fails loud rather than sending a truncated request.

## Configuration

Every field is required except the paired route override; there are no defaults.

| Key | Contract |
|---|---|
| `instructions` | Non-empty task framing the auxiliary model reads. Deployment policy, so the package supplies none. |
| `maxQuestions` | Positive cap on accepted questions per turn. |
| `maxInputBytes` | Positive UTF-8 byte ceiling for the final framed user prompt. |
| `maxOutputTokens` | Positive auxiliary generation token cap. |
| `timeoutMs` | Positive end-to-end deadline within the runtime timer limit. |
| `minAnswerBytes` | Non-negative shortest answer, in UTF-8 bytes, worth suggesting follow-ups for. |
| `provider`, `model` | Optional explicit route; both or neither. |

## Model Experience

### Auxiliary follow-up request

#### What the model sees

The suggestion model receives the deployment's `instructions` as its system prompt and one user message containing a JSON object: `question` (the human prompt that opened the turn), `answer` (the turn's final assistant text), and `tools` (the distinct tool names the turn called). The model is expected to reply with a JSON string array.

#### Token effect

The auxiliary request consumes tokens for one turn of context plus `maxOutputTokens`; it is not part of the main agent request and never enters derived history. The main conversation prompt carries no output-format rule for follow-ups, so no per-turn instruction tokens are spent on them.

#### KV Cache effect

No main-request invalidation. The system framing is fixed per deployment and reusable across calls; the user message changes with every turn.

## Known Limitations and Deferred Work

- The generator reads the turn's material from the session log instead of receiving it from the loop, so a surface that renders a turn before its `turn/end` commit shows no suggestions until the event arrives.
- Accepted questions are recorded verbatim; there is no per-deployment filter for questions that must not be offered.
- The suggestion route defaults to the conversation's route; a deployment that must isolate auxiliary traffic configures `provider` and `model` explicitly.
