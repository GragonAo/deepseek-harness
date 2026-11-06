/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ConfigurableProviderView, DiscoveredModelView, ManagedProviderModelView, ManagedProviderView } from './llm.ts'
import { modelCatalogFailureSchema, modelProviderGroupSchema } from './sessions.schema.ts'

/** ConfigurableProviderView row of llm.providers. */
export const configurableProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  declared: z.boolean().optional(),
  source: z.enum(['registry', 'config']).optional(),
  apiKeyConfigured: z.boolean().optional(),
}) satisfies z.ZodType<Wire<ConfigurableProviderView>>

/** llm.providers request payload. */
export const llmProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.providers'>>>

/** llm.providers response value. */
export const llmProvidersValueSchema = z.object({
  providers: z.array(configurableProviderViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providers'>>>

/** llm.models request payload. */
export const llmModelsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.models'>>>

/** llm.models response value. */
export const llmModelsValueSchema = z.object({
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.models'>>>

/** DiscoveredModelView row of llm.discoverModels. */
export const discoveredModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<DiscoveredModelView>>

/** llm.discoverModels request payload. */
export const llmDiscoverModelsRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  // Write-only at the host: used for this one interrogation, never stored and
  // never returned. It does ride the client's outgoing envelope like every
  // other secret-bearing payload (`credentials.set`, `settings.update`), which
  // `subscribeEnvelopes()` observers can see — redacting that tap is a
  // configuration-plane-wide change, not this method's to make alone.
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.discoverModels'>>>

/** llm.discoverModels response value. */
export const llmDiscoverModelsValueSchema = z.object({
  models: z.array(discoveredModelViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.discoverModels'>>>

/** ManagedProviderModelView row of a managed route. */
export const managedProviderModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<ManagedProviderModelView>>

/** ManagedProviderView reply of the write methods: a route as it is now stored. */
export const managedProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  api: z.string().min(1),
  baseURL: z.string().min(1),
  models: z.array(managedProviderModelViewSchema),
  enabled: z.boolean(),
  apiKeyConfigured: z.boolean(),
  updatedAt: z.string().min(1),
}) satisfies z.ZodType<Wire<ManagedProviderView>>

/** llm.addProvider request payload: the whole record. */
export const llmAddProviderRequestSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  api: z.string().min(1),
  baseURL: z.string().min(1),
  // Write-only: stored with the record, reported back only as apiKeyConfigured.
  apiKey: z.string().min(1).optional(),
  models: z.array(managedProviderModelViewSchema),
  enabled: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.addProvider'>>>

/** llm.addProvider response value. */
export const llmAddProviderValueSchema = z.object({
  provider: managedProviderViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.addProvider'>>>

/** llm.updateProvider request payload: the id plus the fields to replace. */
export const llmUpdateProviderRequestSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  // A string replaces the stored credential, null clears it, omission keeps it.
  apiKey: z.string().min(1).nullable().optional(),
  models: z.array(managedProviderModelViewSchema).optional(),
  enabled: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.updateProvider'>>>

/** llm.updateProvider response value. */
export const llmUpdateProviderValueSchema = z.object({
  provider: managedProviderViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.updateProvider'>>>

/** llm.removeProvider request payload. */
export const llmRemoveProviderRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.removeProvider'>>>

/** llm.removeProvider response value. */
export const llmRemoveProviderValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'llm.removeProvider'>>>
