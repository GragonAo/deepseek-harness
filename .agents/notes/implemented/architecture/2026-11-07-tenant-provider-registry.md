# Agent Note: The tenant's providers and credentials live in PostgreSQL

Status: implemented

English | [中文](2026-11-07-tenant-provider-registry.zh.md)

> A model route — its id, API dialect, endpoint, model list, and credential — came only from deployment configuration, so changing one provider meant editing the config, rebuilding the image, and restarting the tenant host; and the chat page let a user write models into a settings document, which is the opposite of a business deployment where an administrator configures providers and users only pick a model.

## Problem

`llm-pi-ai` resolved its routes from `config.providers` in `cordis.yml`, with the credential behind an `apiKeyEnv` variable. Two consequences followed. Every provider change was a deployment: configuration, image, restart, per tenant. And the only write path the product offered was the chat page's "discover and adopt models" flow, which mutated a per-user settings document — so a user could invent a provider route, and an enterprise deployment could not centrally configure one.

## Decision

- **Provider records are tenant-scoped storage.** `@deepseek-ai/dsh-llm-providers-postgres` owns one `shared: true` KV unit (`llm_providers`, table `provider`, one JSON document per provider id). `shared` means "the tenant's", with no user dimension: there is no per-user LLM configuration.
- **Definition and implementation are separate.** `dsh-llm` gains `LlmProviderStore` (`ctx.llmProviders`: `list`/`refresh`/`snapshot`/`upsert`/`remove`/`onChange`); the PostgreSQL package is one provider of it.
- **Configuration becomes the fallback tier.** Route resolution merges `config.providers` with the registry snapshot, registry first; an empty registry behaves exactly as before. The credential resolves per request from the ambient tenant's record, so provider ids that collide across tenants never share a key.
- **Writes apply to the next request.** The store notifies on change and `llm-pi-ai` re-registers routes and directory; no process restart, and replicas sharing PostgreSQL see each other's writes on their next `refresh()`.
- **Management is RPC**: `llm.addProvider`, `llm.updateProvider`, `llm.removeProvider` beside `llm.providers` and `llm.models`. A credential is write-only: the view reports `apiKeyConfigured`. The write methods carry no permission bit — the harness trusts its network and leaves role checks to the business layer above it.
- **The user surface narrows.** The chat page only reads the catalog and calls `session.selectModel`; the discover-and-adopt write path is gone.

## Verification

Registry package tests, `llm-pi-ai` tenant-registry tests, and api-proxy provider tests cover the merge, the credential resolution, and the write path. On the deployed tenant host (130): an empty registry serves only configuration routes with `source: 'config'`; `addProvider` makes the route appear with `source: 'registry'` on the very next read and in `llm.models`; `updateProvider` keeps the stored credential when the request omits `apiKey`; `removeProvider` falls back to configuration. The chat page, behind a real login, shows the new model after reopening the menu.

## Known limitation

Route *topology* is process-global. One process serving several tenants resolves a provider id that two tenants configured differently to whichever set was resolved last; credentials are not shared. Per-tenant endpoints need route ids derived per tenant, or a resolution path that reads transport configuration per tenant.
