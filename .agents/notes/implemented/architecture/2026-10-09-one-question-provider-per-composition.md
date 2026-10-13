# Agent Note: One question provider per composition

Status: implemented

## Problem

The `userQuestions` seam accepts exactly one provider per context. `@deepseek-ai/dsh-host-apiproxy` registered its mux-backed provider at load with no switch, so a composition that also mounts the multi-tenant business channel (`@deepseek-ai/dsh-tenant-questions`) failed to start with `a user-questions provider is already registered`. Answering questions on the web plane is not an option for a tenant deployment that runs no web client: leaving the channel unmounted made `tenantQuestion.list` and `tenantQuestion.answer` answer HTTP 503 `question channel is not mounted`, left no `user-question/asked` audit event in the session log, and let each ask expire on the seam's 120 s deadline with the generic `Nobody can answer a question in this session`.

## Decision

`ApiProxyService` carries `userQuestionsProvider` (default `true`) and hands it to `createApiProxy`, which registers the mux-backed provider only when the value is not `false`. The provider is built by `registerQuestionProvider` and disposed through the same effect, so a deployment that turns it off leaves no pending-question table behind. The tenant spine mounts its `api-gateway` row with `userQuestionsProvider: false` and keeps `tenant-questions` as the only provider.

The seam definition row (`user-questions`) stays mounted in every composition. It contributes no provider; withdrawing it removes the seam, and both the gateway and the tenant channel then fail injection, which the tenant composition reports as missing services at startup.

## Alternatives considered

- **Register the tenant channel and let it win** — lost: the seam's duplicate-provider error is the guard that keeps two channels from splitting one ask's answer, so replacing a provider silently would move the failure from startup to a lost answer.
- **Disable the `user-questions` row to free the seam** — lost: that removes the seam itself rather than one provider, and the tenant composition refuses to start on the resulting unsatisfied injections.
- **Suffix the config key with the god-object's other doors (a boolean per channel)** — lost: the gateway has exactly one question behaviour to switch; a per-channel map would name channels the gateway does not know.

## Consequences

A tenant deployment answers questions through its business API: `tenantQuestion.list` reports the pending ask with its `sessionId` and expiry, `tenantQuestion.answer` settles a live ask and is refused as `bad-request` for an unknown ask, a foreign session, an option the question never offered, or a second answer, and the session log carries the `user-question/asked` / `user-question/decided` pair. A question that goes unanswered fails with the channel's own window message (60 s in this deployment) instead of the seam's generic failure.

The switch makes a third state reachable: with the gateway provider off and no other provider mounted, asks fail immediately with `NO_PROVIDER`. That is the correct fail-fast for a composition that answers no questions, and it replaces a 120 s wait.

## Testing

`packages/tenant/tenant-app` covers the spine's `api-gateway` row and the seam's wait budget against the channel's window. Live evidence from the tenant deployment: `tenantQuestion.list` answers 200 with the pending ask, a correct answer settles it in under 5 s and the model receives `{"answers":[{"id":"pick","selected":["甲"]}]}`, and each refusal above returns `bad-request` while the ask stays pending.
