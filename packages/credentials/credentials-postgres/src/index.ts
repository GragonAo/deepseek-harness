/**
 * PostgreSQL-backed credentials provider for the multi-tenant carrier. One KV
 * unit named `credentials_doc` keeps the writable per-tenant credential map
 * (reference → value) under the ambient tenant's schema, so no tenant reads or
 * writes a host-side `.credentials.yaml`. Layering mirrors
 * `credentials-local` with the managed file replaced by Postgres:
 *
 * ```text
 * inherited process environment     (read-only, wins)
 * > postgres per-tenant store        (provider-managed, writable)
 * > <cwd>/.env                       (read-only fallback)
 * > $DSH_HOME/.env                   (read-only fallback)
 * ```
 *
 * Only the writable store is per-tenant; the inherited environment and the two
 * `.env` layers are the process's own, never a tenant's.
 * @module @deepseek-ai/dsh-credentials-postgres
 */

import { Service } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentEntry } from '@deepseek-ai/dsh-launch-environment'
import { currentTenant, currentUser, requireTenant, requireUser, userPartitionName, type Tenant, type UserId } from '@deepseek-ai/dsh-tenant'
import { storageBackendServiceKey, type KvFacet, type KvUnit } from '@deepseek-ai/dsh-storage'

/** KV unit name hosting the credentials map; unique across the storage hub. */
const UNIT_NAME = 'credentials_doc'
/** Single table whose keys are credential references and values are secrets. */
const REF_TABLE = 'ref'
/** Static identity of the credentials unit: one record table, no global slot. */
const UNIT_DESCRIPTOR = { name: UNIT_NAME, version: 1, tables: [REF_TABLE], hasGlobal: false } as const

/**
 * PostgreSQL `CredentialProvider`: the writable store lives in the `postgres`
 * backend's per-tenant schema. Outside a tenant scope the store is empty and
 * reads resolve only through the process environment and `.env` fallbacks.
 */
export class PostgresCredentialProvider extends CredentialProvider {
  // The hub (`storage`) resolves the postgres backend through `ctx.storage.backend`;
  // the backend lifecycle key (`storage.backend.postgres`) orders activation
  // after the backend registers, exactly as `storage-domain` wires it.
  static inject = ['storage', storageBackendServiceKey('postgres')]

  /** Open unit handles, keyed by (tenant, user) — the ambient scope at first use. */
  private readonly units = new Map<string, KvUnit>()

  /** The postgres backend registered on the storage hub. */
  private backendKv(): KvFacet {
    const backend = this.ctx.storage.backend.get('postgres')
    if (backend.kv === undefined) {
      throw new Error('credentials-postgres: postgres backend exposes no kv facet')
    }
    return backend.kv
  }

  /** Open (or reuse) the per-(tenant, user) credentials unit, under the ambient scope. */
  private async unit(tenant: Tenant, user: UserId): Promise<KvUnit> {
    const key = `${tenant.id}.${userPartitionName(user)}`
    const existing = this.units.get(key)
    if (existing !== undefined) return existing
    const unit = await this.backendKv().open(UNIT_DESCRIPTOR)
    this.units.set(key, unit)
    return unit
  }

  /** Read the ambient (tenant, user) credential map; empty outside any scope. */
  private async loadDoc(): Promise<Record<string, string>> {
    const tenant = currentTenant()
    const user = currentUser()
    if (tenant === undefined || user === undefined) return {}
    const unit = await this.unit(tenant, user)
    const snapshot = await unit.loadAll()
    return (snapshot.tables[REF_TABLE] ?? {}) as Record<string, string>
  }

  /** The inherited-environment value, or `undefined` when empty or unset. */
  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  /** The `.env` fallback below the writable store. */
  private dotenvFallback(ref: CredentialRef): LaunchEnvironmentEntry | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return { value: inherited, source: 'env' }
    const stored = (await this.loadDoc())[ref]
    if (stored !== undefined && stored.length > 0) return { value: stored, source: 'postgres' }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { value: fallback.value, source: fallback.source }
    return undefined
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.inherited(ref) !== undefined) {
      return { configured: true, source: 'env', writable: false }
    }
    const stored = (await this.loadDoc())[ref]
    if (stored !== undefined && stored.length > 0) return { configured: true, source: 'postgres', writable: true }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { configured: true, source: fallback.source, writable: true }
    return { configured: false, writable: true }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-postgres: an empty value cannot be stored for "${ref}"; use unset`)
    }
    this.assertUnshadowed(ref, 'set')
    const unit = await this.unit(requireTenant(), requireUser())
    await unit.putRecord(REF_TABLE, ref, value)
    this.notifyUpdated(ref)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    this.assertUnshadowed(ref, 'unset')
    const unit = await this.unit(requireTenant(), requireUser())
    await unit.deleteRecord(REF_TABLE, ref)
    this.notifyUpdated(ref)
  }

  /** Reject a write the inherited environment would shadow into no-effect. */
  private assertUnshadowed(ref: CredentialRef, verb: 'set' | 'unset'): void {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `credentials-postgres: "${ref}" is supplied read-only by the launching environment, so ${verb} would be`
        + ' shadowed; unset it in the shell you start dsh from instead',
      )
    }
  }

  * [Service.init](): Generator<() => Promise<void>, void, void> {
    yield async () => {
      const handles = [...this.units.values()]
      this.units.clear()
      await Promise.allSettled(handles.map(unit => unit.close()))
    }
  }
}

export default PostgresCredentialProvider
