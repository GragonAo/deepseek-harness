/**
 * Ambient request-partition seam: the tenant and subject identity a
 * deployment partitions durable data and private roots by, behind one optional
 * service.
 *
 * A partitioned deployment (multi-tenancy) mounts a {@link PartitionScope} on
 * `ctx.partitionScope`; a consumer that stores per-tenant or per-user state
 * reads it through {@link currentPartition} and depends on this seam instead
 * of on a tenancy implementation. A deployment that mounts no provider is a
 * single-partition deployment: `currentPartition` returns `undefined` and
 * every consumer keeps its single-partition behavior.
 *
 * @module @deepseek-ai/dsh-partition-scope
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The request partition an operation acts under: which tenant and
 * authenticated subject the ambient request belongs to, the identifier forms a
 * storage backend addresses by name, and the deployment-private root this
 * partition's persistent state lives under.
 *
 * The provider derives `tenantName`/`userName` from the raw ids, so a consumer
 * never needs the deployment's derivation rule — only the safe form it must
 * address a schema, guard key, or container name by.
 */
export interface RequestPartition {
  /** The tenant's opaque id, as the deployment registered it. */
  readonly tenant: string
  /** The authenticated subject; present exactly when the deployment isolates per user. */
  readonly user?: string
  /** Storage-safe identifier form of {@link RequestPartition.tenant}. */
  readonly tenantName: string
  /** Storage-safe identifier form of {@link RequestPartition.user}; present with the user. */
  readonly userName?: string
  /** Deployment-private root holding this partition's settings, credentials, and skills. */
  readonly dataRoot: string
}

/** Optional ambient-partition supplier; only a partitioned deployment registers it. */
export interface PartitionScope {
  /**
   * The partition the ambient request acts as.
   * @returns the ambient partition, or `undefined` outside any request partition.
   */
  current(): RequestPartition | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ambient request-partition provider; only a partitioned deployment registers it. */
    partitionScope?: PartitionScope | undefined
  }
}

/**
 * The ambient request partition.
 *
 * Read through `ctx.get` (the strict store read of the optional-service
 * idiom), not the topology-sensitive property proxy: a deployment that mounts
 * no provider must resolve to `undefined` rather than to a pending service.
 * @param ctx - context whose partition provider to read.
 * @returns the ambient partition, or `undefined` without one.
 */
export function currentPartition(ctx: Context): RequestPartition | undefined {
  return ctx.get('partitionScope')?.current()
}

/**
 * The failure code a partition-scoped backend raises for an operation that ran
 * outside any request partition: such a backend cannot address a partitionless
 * call, so it rejects instead of serving another partition's tuples.
 */
const NO_PARTITION_IN_SCOPE = 'NO_TENANT_IN_SCOPE'

/**
 * Whether a failure is a partition-scoped backend rejecting an operation that
 * ran outside any request partition.
 *
 * A consumer that must tolerate the partitionless case — a registry whose
 * eager boot-time initialization has no request scope yet — recognizes it
 * through this predicate instead of depending on the backend's error class.
 * Every partition-scoped backend in this repository rejects with the code
 * `NO_TENANT_IN_SCOPE`.
 * @param error - the failure a partition-scoped operation raised.
 * @returns whether the operation ran outside any request partition.
 */
export function isPartitionlessFailure(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === NO_PARTITION_IN_SCOPE
}
