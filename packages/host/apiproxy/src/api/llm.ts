/**
 * llm domain contract: host-scoped provider topology for configuration
 * surfaces. `llm.providers` merges the configurable-provider directory
 * (which providers CAN be configured, and where their settings live) with the
 * live route registry; `llm.models` is the session-independent model catalog
 * (the same groups as `session.models`, without a per-session selection).
 * Clients invalidate from the forwarded `llm/adapters-updated` and
 * `settings/document-updated` owner events.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { ModelCatalogFailure, ModelProviderGroup } from './sessions.ts'

/** Wire view of one configurable provider. */
export interface ConfigurableProviderView {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  provider: string
  /** Human-readable name for configuration surfaces. */
  displayName: string
  /** Settings namespace whose section configures this provider. */
  settingsNs: string
  /** Path from that section's root to the provider's profile object (empty = whole section). */
  settingsPath: string[]
  /** Whether the route is currently registered (its models are requestable). */
  active: boolean
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it. Absent when the adapter draws no such distinction, so a
   * surface must treat absence as "unknown", not as "shipped".
   */
  declared?: boolean
  /**
   * Where this route's definition comes from: a record an administrator stored
   * for the tenant, or the configuration tiers below it. Absent when the
   * deployment mounts no tenant registry, so a surface reads absence as
   * "unknown", never as "configuration".
   */
  source?: 'registry' | 'config'
  /** Whether a credential is stored for this route. The key itself is never returned. */
  apiKeyConfigured?: boolean
}

/** Wire view of one model an administrator-managed route serves. */
export interface ManagedProviderModelView {
  /** Model id the route accepts. */
  id: string
  /** Human-readable name; the id serves as the label when absent. */
  name?: string
  /** Maximum combined context, when the administrator supplied it. */
  contextWindow?: number
  /** Maximum output tokens, when the administrator supplied it. */
  maxTokens?: number
}

/**
 * Wire view of one administrator-managed route. The credential is write-only:
 * the reply reports only whether one is stored.
 */
export interface ManagedProviderView {
  /** Route id the model selection names. */
  provider: string
  /** Human-readable name configuration surfaces show. */
  displayName: string
  /** Wire protocol the route speaks. */
  api: string
  /** Endpoint every model on this route reaches. */
  baseURL: string
  /** The models this route serves; it replaces the installed catalog for the route. */
  models: ManagedProviderModelView[]
  /** Whether the route serves requests; a disabled record stays stored and inactive. */
  enabled: boolean
  /** Whether a credential is stored for this route. */
  apiKeyConfigured: boolean
  /** When this record was last written. */
  updatedAt: string
}

/** Full write of one managed route: what `llm.addProvider` accepts. */
export interface ManagedProviderWrite {
  provider: string
  displayName: string
  api: string
  baseURL: string
  /** Credential stored with the record; write-only. */
  apiKey?: string
  models: ManagedProviderModelView[]
  enabled?: boolean
}

/** Partial write of an existing managed route: what `llm.updateProvider` accepts. */
export interface ManagedProviderPatch {
  provider: string
  displayName?: string
  api?: string
  baseURL?: string
  /** A string replaces the stored key; null clears it; omission leaves it untouched. */
  apiKey?: string | null
  models?: ManagedProviderModelView[]
  enabled?: boolean
}

/** Llm-domain unary methods (the map keys llm.* of RpcMethodMap). */
export interface LlmApi {
  /**
   * List every configurable provider with its live/dormant state, in
   * directory declaration order. Routes registered outside the directory
   * (an adapter that never declared configurability) are appended with their
   * registration identity and no settings address.
   */
  providers(request: RpcRequest<{}>): Promise<RpcResponse<{ providers: ConfigurableProviderView[] }>>

  /**
   * Host-scoped model catalog over every registered provider route: the
   * settings surface's models view, needing no session. Per-provider listing
   * failures ride `failures` without failing the sound groups.
   */
  models(request: RpcRequest<{}>): Promise<RpcResponse<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }>>

  /**
   * Interrogate a provider endpoint the configuration surface is still
   * drafting, and return the models it advertises for the user to adopt.
   *
   * The payload is the draft, not a stored route: `settingsNs` selects the
   * adapter family that answers, and the rest comes from the form. `provider`
   * names the route being edited when there is one — an adapter that already
   * describes that route answers from its own registry, with better metadata
   * and no network call, and needs no endpoint. A route it does not describe is
   * asked over the wire, which is what `baseURL`, `api`, and `apiKey` are for.
   *
   * Nothing is written — the reply is candidates, and only a later
   * `settings.mutate` decides what a route serves. `apiKey` is accepted here
   * but never stored or returned; a provider whose key is already stored omits
   * it and the endpoint answers unauthenticated or refuses.
   */
  discoverModels(
    request: RpcRequest<{
      settingsNs: string
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ models: DiscoveredModelView[] }>>

  /**
   * Store a new provider route for the tenant, or replace an existing one of
   * the same id. Nothing is restarted: the routing consumer re-resolves its
   * route set in process, so the next request reaches the new endpoint.
   *
   * The tenant registry is the deployment's central provider configuration —
   * there is no per-user layer above or below it. The key rides the record and
   * is never returned.
   */
  addProvider(request: RpcRequest<ManagedProviderWrite>): Promise<RpcResponse<{ provider: ManagedProviderView }>>

  /**
   * Update an existing managed route in place; unspecified fields keep their
   * stored value and `apiKey: null` clears the credential. A route the tenant
   * registry does not hold is refused rather than created.
   */
  updateProvider(request: RpcRequest<ManagedProviderPatch>): Promise<RpcResponse<{ provider: ManagedProviderView }>>

  /**
   * Delete a managed route. The configuration tier below it is untouched, so a
   * route the deployment configures falls back to that configuration instead of
   * disappearing.
   */
  removeProvider(request: RpcRequest<{ provider: string }>): Promise<RpcResponse<{}>>
}

/** Wire view of one model an interrogated endpoint advertises. */
export interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}
