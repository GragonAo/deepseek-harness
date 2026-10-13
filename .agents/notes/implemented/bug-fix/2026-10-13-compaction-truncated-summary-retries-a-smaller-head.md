# Agent Note: Compaction retries a truncated summary against a smaller head

Status: implemented

English | [中文](2026-10-13-compaction-truncated-summary-retries-a-smaller-head.zh.md)

## Problem

A summarization that reached `maxTokens` threw with code `MAX_TOKENS`, and the summarizer discarded the whole summary rather than landing an incomplete checkpoint. The surface was therefore unchanged, so the next step's pressure check re-measured the same over-threshold surface and re-selected the same region. The `compactionRetries` budget never applied, because the failure arrived as an exception instead of as a below-threshold result. Every step paid a full summarization call, truncated at the same cap, and made no progress.

A deployment on the 130 server pinned the loop: session `session-8bf5b412-128c-4a04-8587-db274725f370` logged 36 compaction brackets with exactly one summarized step between consecutive ones and none with two, 21 brackets with no `compaction/summary` at all, and 14 consecutive failures occupying ~130 s each inside one 41.6-minute window — about 73% of it. Progress resumed only after that window's single success, which emitted 8,066 tokens against the 8,192 cap. The region exceeded the budget by a small margin, so the truncation repeated at the same size forever.

## Decision

The `compactIfNeeded` pressure retries catch a truncation and grow the retained-tail budget before the next attempt, so a retry summarizes a smaller head. `grownRetainTokens` doubles that budget and clamps it below `thresholdTokens`, which preserves the invariant `resolveCompactSpec` asserts: a retained tail at or above the threshold leaves no head to compact. A truncation with no head left, or one that survives the bounded attempts, is rethrown with its original `MAX_TOKENS` code instead of the generic above-threshold error. `isSummaryTruncation` in `summarizer.ts` is the single definition of the truncation code, shared by `finishError` and the retry loop.

## Alternatives considered

- **Raise `maxTokens` when the region is large.** The cap is the deployment's stated budget for the summarization call, so exceeding it implicitly contradicts explicit configuration ownership, and the sufficient value depends on the model's output capacity, which this package cannot observe.
- **Retry the identical region and budget.** The identical region, budget, and model reproduce the identical truncation, so the retry would only multiply the cost the defect already paid.
- **Cut a smaller summarized range directly.** The retained-tail budget already defines the head, so growing it reuses the existing range selection and its tool-call/result balancing instead of adding a second cut rule.
- **Treat the truncated summary as usable.** Fail-closed is deliberate: an incomplete checkpoint silently loses context that the next model cannot recover.

## Consequences

- A step that truncates lands a checkpoint as soon as a smaller head fits, instead of stalling while spending a summarization call per step.
- The extra call cost stays bounded by the existing `compactionRetries`; the change adds no configuration.
- The truncation stays observable with its `MAX_TOKENS` code rather than being replaced by the generic above-threshold message.
- A surface whose head cannot shrink enough still fails, but now with a bounded number of attempts and the cause named.

### Verification

- `npx vitest run packages/compaction/compaction-basic` — 126 tests pass, including four new ones: a retry that succeeds against a strictly smaller head, a truncation that survives the attempts and is rethrown unchanged, the below-threshold clamp that leaves no head, and a zero-budget retry that still differs from its first attempt.
- `npx vitest run packages/compaction/compaction-basic --coverage` — per-file 100% statements, branches, functions, and lines on `config.ts`, `index.ts`, `region.ts`, and `summarizer.ts`.
- `npx tsx scripts/run-oxlint.ts packages/compaction/compaction-basic` — 0 warnings, 0 errors; `npx tsc -b packages/compaction/compaction-basic/tsconfig.json` clean.

## Related

- [`compaction-basic` README](../../../../packages/compaction/compaction-basic/README.md)
- [Summarization failure preserves the latest durable surface](../../../../packages/compaction/compaction-basic/README.md#known-limitations-and-deferred-work)
