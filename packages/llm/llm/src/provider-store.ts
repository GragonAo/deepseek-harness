/**
 * Administrator-managed provider records: the durable seam a deployment writes
 * so a provider route and its credential reach every tenant of the deployment
 * without a host-side config file. The seam is a Service Definition only — a
 * deployment supplies the medium (the multi-tenant carrier uses Postgres),
 * consumers read the records, and a change notification lets them re-resolve
 * their routing in the same process, so an added or edited provider applies
 * without a restart.
 *
 * @module @deepseek-ai/dsh-llm/src/provider-store
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/** One selectable model a stored provider route serves. */
export interface LlmStoredModel {
  /** Wire model id sent to the endpoint. */
  id: string
  /** Display name selector surfaces show; defaults to the id. */
  name?: string
  /** Context window in tokens, when the administrator narrowed it. */
  contextWindow?: number
  /** Maximum output tokens per request, when the administrator narrowed it. */
  maxTokens?: number
  /** Selectable reasoning level to its wire spelling. */
  reasoningEfforts?: Record<string, string>
}

/**
 * One administrator-managed provider route. The record is the whole durable
 * fact: without it the route does not exist; with it the endpoint, the wire
 * API, the model list, and the credential are all known.
 */
export interface LlmProviderRecord {
  /** Route id matching [a-z0-9][a-z0-9._-]*; the key the registry stores under. */
  id: string
  /** Label configuration and selector surfaces show. */
  displayName: string
  /** Wire API the adapter speaks to this endpoint (for example openai-completions). */
  api: string
  /** Endpoint base URL; a trailing slash is tolerated. */
  baseURL: string
  /** Credential the route authenticates with; absent defers to ambient discovery. */
  apiKey?: string
  /** Model catalog the route serves. */
  models: readonly LlmStoredModel[]
  /** Whether the route may serve requests. */
  enabled: boolean
  /** ISO-8601 instant of the last write. */
  updatedAt: string
  /** Subject that performed the last write, when known. */
  updatedBy?: string
}

/** Route-id shape accepted by assertProviderRecord. */
const ROUTE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Read one required non-empty string field.
 * @param source - the candidate object.
 * @param field - field name to read.
 * @param label - record id or subject used in the error message.
 * @returns the trimmed value.
 */
function requiredString(source: Record<string, unknown>, field: string, label: string): string {
  const value = source[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('llm provider ' + label + ' must be a non-empty string (field "' + field + '")')
  }
  return value.trim()
}

/**
 * Read one optional non-empty string field.
 * @param source - the candidate object.
 * @param field - field name to read.
 * @param label - record id used in the error message.
 * @returns the trimmed value or undefined when absent.
 */
function optionalString(source: Record<string, unknown>, field: string, label: string): string | undefined {
  const value = source[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('llm provider ' + label + ' field "' + field + '" must be a non-empty string when present')
  }
  return value.trim()
}

/**
 * Read one optional positive integer field.
 * @param source - the candidate object.
 * @param field - field name to read.
 * @param label - record id used in the error message.
 * @returns the value or undefined when absent.
 */
function optionalCount(source: Record<string, unknown>, field: string, label: string): number | undefined {
  const value = source[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError('llm provider ' + label + ' field "' + field + '" must be a positive integer when present')
  }
  return value
}

/**
 * Validate one stored model entry.
 * @param value - the candidate entry.
 * @param label - record id used in error messages.
 * @returns the normalized entry.
 */
function assertStoredModel(value: unknown, label: string): LlmStoredModel {
  if (!isPlainObject(value)) throw new TypeError('llm provider ' + label + ' model entries must be objects')
  const model: LlmStoredModel = { id: requiredString(value, 'id', label) }
  const name = optionalString(value, 'name', label)
  if (name !== undefined) model.name = name
  const contextWindow = optionalCount(value, 'contextWindow', label)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = optionalCount(value, 'maxTokens', label)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  const efforts = value['reasoningEfforts']
  if (efforts !== undefined) {
    if (!isPlainObject(efforts)) throw new TypeError('llm provider ' + label + ' field reasoningEfforts must be an object')
    const normalized: Record<string, string> = {}
    for (const [level, spelling] of Object.entries(efforts)) {
      if (typeof spelling !== 'string') {
        throw new TypeError('llm provider ' + label + ' reasoning effort "' + level + '" must map to a string')
      }
      normalized[level] = spelling
    }
    model.reasoningEfforts = normalized
  }
  return model
}

/**
 * Validate one stored provider record at the durable read/write boundary.
 * Anything this rejects never reaches an adapter, so a corrupt row cannot take a
 * working route down with it.
 * @param value - the candidate record read from the store or a request body.
 * @returns the record with trimmed strings and copied model entries.
 */
export function assertProviderRecord(value: unknown): LlmProviderRecord {
  if (!isPlainObject(value)) throw new TypeError('llm provider record must be an object')
  const id = requiredString(value, 'id', 'record')
  if (!ROUTE_ID_RE.test(id)) {
    throw new TypeError('llm provider record id "' + id + '" must match [a-z0-9][a-z0-9._-]*')
  }
  const models = value['models']
  if (!Array.isArray(models)) throw new TypeError('llm provider ' + id + ' field models must be an array')
  const record: LlmProviderRecord = {
    id,
    displayName: requiredString(value, 'displayName', id),
    api: requiredString(value, 'api', id),
    baseURL: requiredString(value, 'baseURL', id),
    models: models.map(entry => assertStoredModel(entry, id)),
    enabled: value['enabled'] !== false,
    updatedAt: optionalString(value, 'updatedAt', id) ?? new Date().toISOString(),
  }
  const apiKey = optionalString(value, 'apiKey', id)
  if (apiKey !== undefined) record.apiKey = apiKey
  const updatedBy = optionalString(value, 'updatedBy', id)
  if (updatedBy !== undefined) record.updatedBy = updatedBy
  return record
}

/**
 * The provider registry seam: the deployment's administrator-managed provider
 * routes. A deployment supplies the medium; consumers read list() and subscribe
 * through onChange(), and the write path is reserved for the management
 * surface (llm.providers.add, llm.providers.update, llm.providers.remove).
 */
export abstract class LlmProviderStore extends Service {
  /** Change listeners registered through onChange and released with their effect. */
  private readonly listeners = new Set<() => void>()

  /**
   * @param ctx - Cordis context the service registers on as llmProviders.
   */
  constructor(ctx: Context) {
    super(ctx, 'llmProviders')
  }

  /** Whether this medium accepts writes; a read-only store still lists records. */
  abstract get writable(): boolean

  /**
   * Read every provider record the deployment manages.
   * @returns the records; empty when nothing has been stored yet.
   */
  abstract list(): Promise<readonly LlmProviderRecord[]>

  /**
   * The records last loaded, without touching the medium.
   * A resolution path that must stay synchronous (the routing profile map) reads
   * this; it is empty until the first load.
   * @returns the cached records, or an empty list when nothing is loaded.
   */
  abstract snapshot(): readonly LlmProviderRecord[]

  /**
   * Reload the records from the medium and cache them.
   * @returns the records now cached; implementations notify listeners only when
   * the set actually changed.
   */
  abstract refresh(): Promise<readonly LlmProviderRecord[]>

  /**
   * Insert or replace one record durably.
   * @param record - the record to store; the implementation validates it.
   * @returns resolution after durability, then change notification.
   */
  abstract upsert(record: LlmProviderRecord): Promise<void>

  /**
   * Delete one record durably; a missing id is a no-op.
   * @param id - route id to delete.
   * @returns resolution after durability, then change notification.
   */
  abstract remove(id: string): Promise<void>

  /**
   * Subscribe to record changes.
   * @param listener - invoked after each successful write.
   * @returns the disposer that unregisters the listener.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Notify every listener that the record set changed. */
  protected notifyChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      }
      catch (error: unknown) {
        // A consumer's re-resolution failure must not fail a write that already
        // reached storage, and must not starve the remaining listeners.
        this.ctx.logger.warn('llm: provider change listener failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    llmProviders: LlmProviderStore
  }
}
