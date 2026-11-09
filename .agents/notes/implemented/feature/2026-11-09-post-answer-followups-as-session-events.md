# Agent Note: Post-answer follow-up suggestions as session events

Status: implemented

English | [中文](2026-11-09-post-answer-followups-as-session-events.zh.md)

## Problem

A case-management front end shows, under each finished answer, three questions the user is most likely to ask next. That feature was built inside the prompt: the system instruction told the main model to end every answer with a `[hermes-followup]` block containing a JSON array, and the front end parsed the tag out of the streamed text, hid it from the rendered answer, and drew the chips.

Every part of that arrangement was fragile in a way the product could not see:

- The instruction lived in the deployment's prompt while the parser lived in the front end. A wording change on either side silently disabled the feature for new turns, and nothing failed.
- The tag is text, so it arrives in fragments. The front end had to decide when a partial tag was a tag, when it was prose, and when a failed block was worth waiting for — three streaming states that exist only because structured data was written into a natural-language stream.
- The block is in the answer text, so every other reader of the answer had to peel it: the share export, the copy path, the history rebuild, and any consumer that showed the answer elsewhere.
- The main conversation prompt carried a per-answer output-format rule that cost instruction tokens on every turn, including turns nobody would follow up on, and the rule shaped the answer itself.
- A turn's suggestions could not be recomputed by a different model, could not be replayed from the log, and did not exist at all when the main model ignored the instruction.

## Decision

### Follow-ups are a logged fact, not answer text

The new `@deepseek-ai/dsh-session-followups` package listens for a `turn/end` whose `reason.kind` is `completed` and, for a top-level session, asks an auxiliary model which questions to offer. The accepted ones are recorded as a log-only `followup/suggested` event carrying the turn and the question list, preceded by a log-only `followup/llm-request` record of the exact auxiliary dispatch.

This puts follow-ups in the same class of thing as a clarifying question or a deliverable declaration: generated after the turn, addressed to the turn, folded by the consumer that renders it, and reconstructable from the log. The prompt carries no output-format rule for follow-ups, so the answer is not shaped by the feature and no instruction tokens are spent on it. Nothing in derived model history changes, so a turn's suggestions never alter what the next request sees.

### The generator is a function plugin with a deployment-supplied framing

The plugin owns no capability: it consumes `llm` and contributes only events. Its `instructions` config field is required and has no library default, because what a useful follow-up question is — its domain, its language, its register — is deployment policy, the same reason the tenant composition supplies the title policy. The route defaults to the provider/model of the session's last `request/header`, which is the model that produced the answer; an explicit `provider`/`model` pair isolates auxiliary traffic when a deployment needs that.

Two limits protect the turn. The answer must reach `minAnswerBytes`, so an acknowledgement costs no auxiliary call, and the framed prompt must fit `maxInputBytes`, so the answer is bisected to the longest prefix that fits rather than sent oversized. A failure of any kind — missing route, transport error, tool call in the reply, unparseable reply, timeout, plugin disposal — leaves the turn without suggestions and writes one warning; none of it can fail a turn that already completed.

### The run starts after the commit that ended the turn

A `session/event` listener runs inside the append publication of `turn/end`, and a session cannot be appended re-entrantly. The generator therefore starts on the next microtask: the turn's commit returns first, and the batch is appended afterwards. The plugin tracks in-flight runs and aborts them on disposal, waiting for them to settle before its effect resolves.

## Alternatives considered

**Keep the prompt tag and tighten the protocol.** Cheaper in the short term, and it was the existing design. Rejected because it keeps the structural problem: a parser in the front end must track a producer in the prompt, a half-arrived tag must be guessed at, and every other consumer of the answer text must peel the block.

**Reuse `ask_user_question` for the suggestion chips.** Rejected: that tool suspends the turn until an answer or a timeout, so suggestions would make every turn block, and its payload is a question the user must resolve, not an optional next step.

**Add a first-class suggestion message kind to the session format.** Rejected as more surface than the fact deserves: the questions are a per-turn annotation, not a message with a role, and an ordinary event type expresses it without touching the format version.

**Ask the front end's server to call a model for the questions.** Rejected because the turn's material is in the session log, which the harness already owns, and because a second model client outside the harness would not share its routes, its budgets, or its logging.

## Consequences

Both events are required-on-read for builds that do not know them, since `Session.append` cannot mark an event `ignorable`. Adding an ordinary event type does not bump `SESSION_FORMAT_VERSION`; a build that must read an older log needs the type declared.

Suggestions exist only after the turn's `turn/end` commit, so a surface that renders a turn while it is still running shows the chips when the event arrives rather than with the final text.

The deployment must supply `instructions`; the package deliberately ships no default wording.

A reasoning provider spends `maxOutputTokens` on thinking before it emits any text. Measured on `newapi` serving `deepseek-v4.1-flash`, one suggestion run used 676 reasoning tokens out of a 1200-token budget; at 256 the reply finished as `length` with an empty body, and an empty body parses to no questions. A deployment pointed at such a model must budget reasoning plus answer — the tenant composition sets 2048 — and an empty parse writes one warning naming the finish reason and the text size, so a budget too small to finish thinking shows up in the log instead of as a feature that silently never fires.

Business surfaces read the questions from the event instead of the answer text. A consumer that keeps parsing a legacy tag must treat the event as authoritative for turns that carry one, or a reload after an upgrade could show the same three questions twice.

`packages/session/session-followups/tests/followups.spec.ts` pins the event order, the request record before dispatch, the skip rules, the route resolution, the byte budget and its bisection, every finish-reason failure, timeout, disposal, and the warning-not-throw path; `tests/invariant.spec.ts` pins the durable payload rules for both events, including the replay check on mount.
