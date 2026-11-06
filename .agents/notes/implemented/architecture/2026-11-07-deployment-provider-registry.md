# Agent Note: The deployment's provider registry, and a model per turn

Status: implemented

English | [中文](2026-11-07-deployment-provider-registry.zh.md)

> A model route — its id, API dialect, endpoint, model list, and credential — came only from deployment configuration, so changing one provider meant editing the config, rebuilding the image, and restarting the tenant host; and a model choice only took effect on a session that was starting, because the choice was a session default rather than part of a prompt.

## Problem

`llm-pi-ai` resolved its routes from `config.providers` in `cordis.yml`, with the credential behind an `apiKeyEnv` variable. Every provider change was a deployment. The only write path the product offered was the chat page's discover-and-adopt flow, which mutated a per-user settings document — so a user could invent a provider route, and an enterprise deployment could not centrally configure one.

The model selector had a second limit of its own: it wrote `session.selectModel`, a per-session default. On a session already under way that either had no effect the user could see, or failed outright where the host had no live agent for it. A user who wanted "this question, that model" had no way to say it.

## Decision

- **The registry is deployment-wide, not per tenant.** `@deepseek-ai/dsh-llm-providers-postgres` owns one `shared: true` KV unit (`llm_providers`, table `provider`, one JSON document per provider id) and opens it **once, outside any tenant scope**. The storage backend addresses its `dsh_system` schema for a shared unit opened that way, so every tenant reads the same routes and an administrator configures a provider once for the whole harness. A per-user unit opened outside a tenant still fails closed; only a shared unit may be deployment-wide.
- **Definition and implementation are separate.** `dsh-llm` gains `LlmProviderStore` (`ctx.llmProviders`: `list`/`refresh`/`snapshot`/`upsert`/`remove`/`onChange`); the PostgreSQL package is one provider of it.
- **Configuration becomes the fallback tier.** Route resolution merges `config.providers` with the registry snapshot, registry first; an empty registry behaves exactly as before. One registry means one credential per route id — there is no tenant dimension left to collide on.
- **Writes apply to the next request.** The store notifies on change and `llm-pi-ai` re-registers routes and directory; no process restart, and replicas sharing PostgreSQL see each other's writes on their next `refresh()`.
- **A prompt may carry its own model.** `session.prompt` accepts an optional `model: { provider, model, reasoningEffort? }`. The host resolves it through `session.selectModel`'s own resolver (same route validation, same image-modality admission) and applies it to the live agent before the message is enqueued, so the turn being admitted is the one that rides the new route while the session default is untouched. This is what lets a session that is already under way switch models; `session.selectModel` remains the way to change a session's durable default.
- **Management is RPC**: `llm.addProvider`, `llm.updateProvider`, `llm.removeProvider` beside `llm.providers` and `llm.models`, reached by the business layer without a case dimension. A credential is write-only: the view reports `apiKeyConfigured`. The write methods carry no permission bit — the harness trusts its network and leaves role checks to the business layer above it.
- **The user surface narrows.** The chat page only reads the catalog and sends the picked route with each prompt; the discover-and-adopt write path is gone, and the picker no longer writes a session default.

- **Cross-links.** The selector this extends is [Session model selection in the Web composer](../feature/2026-07-24-web-session-model-selector.md); the default it leaves alone is [Default model follows the picker](../feature/2026-08-07-default-model-follows-the-picker.md); image admission shared with `selectModel` is [Atomic web image admission](../bug-fix/2026-07-29-atomic-web-image-admission.md).

## Verification

Registry package tests prove the system schema is the only one addressed, that writes issued inside a tenant scope still land there, and that every tenant reads the same records. `llm-pi-ai` registry tests and api-proxy provider tests cover the merge and the write path; api-proxy prompt tests cover a turn model applied and refused. On the deployed tenant host (130): an empty registry serves only configuration routes with `source: 'config'`; `addProvider` makes the route appear with `source: 'registry'` on the very next read and in `llm.models`; `updateProvider` keeps the stored credential when the request omits `apiKey`; `removeProvider` falls back to configuration. The admin page manages that one registry with no case input, and an existing chat session switched through the picker answers on the newly picked model for that turn.

## Known limitation

The registry is a single document set, so two deployments sharing one PostgreSQL database share their provider routes. Separating them needs a deployment (or tenant-group) key on the unit, and a resolution path that reads it from transport configuration.
