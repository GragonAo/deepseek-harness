# dsh-partition-scope

English | [中文](README.zh.md)

Ambient request-partition seam. `RequestPartition` is the identity an operation acts under: the tenant, the authenticated subject when the deployment isolates per user, the storage-safe identifier form of each, and the deployment-private root that partition's state lives under. A partitioned deployment mounts a `PartitionScope` on `ctx.partitionScope` and `currentPartition(ctx)` reads it; `isPartitionlessFailure(error)` recognizes a partition-scoped backend rejecting an operation that ran outside any partition. A deployment that mounts no provider is a single-partition deployment.

## Public API

- `RequestPartition` The ambient partition record. `tenant` and `user` are the raw ids the deployment registered, `tenantName`/`userName` their storage-safe forms, and `dataRoot` the deployment-private root holding this partition's settings, credentials, and skills. `user` and `userName` are present exactly when the deployment isolates per user. The provider derives the names, so a consumer never needs the derivation rule — only the form it must address a schema, guard key, or container name by.
- `PartitionScope.current(): RequestPartition | undefined` The provider interface, carried as the optional service `ctx.partitionScope`. Only a partitioned deployment registers it, and a deployment carries one at most.
- `currentPartition(ctx): RequestPartition | undefined` The ambient partition, read through `ctx.get` (the strict store read of the optional-service idiom) rather than the topology-sensitive property proxy, so an absent provider resolves to `undefined` instead of a pending service. `undefined` means a single-partition deployment, or a mounted provider with no ambient request partition.
- `isPartitionlessFailure(error): boolean` Whether a failure is a partition-scoped backend rejecting an operation that ran outside any request partition (code `NO_TENANT_IN_SCOPE`). A consumer that must tolerate the partitionless case — a registry whose eager boot-time initialization has no request scope yet — checks this instead of the backend's error class.

## Design contract

The seam exists so that a consumer which partitions state depends on the seam rather than on a tenancy implementation: `dsh-storage-domain`, `dsh-workspace`, `dsh-settings`, `dsh-settings-file`, and `dsh-credentials-local` read the ambient partition here and import no tenancy package. The provider owns the ambient authority and the partition-name derivation, so removing the tenancy implementation removes partitioning with it and every consumer reverts to its single-partition path.

A partition-scoped backend rejects an operation it cannot place — there is no partition whose tuples it could serve — and reports that rejection with the code `isPartitionlessFailure` matches.

## Known Limitations and Deferred Work

- **One partition per request** — the service carries a single ambient partition, and nesting is not part of it; a consumer that must address two partitions in one request has no seam here.
- **`@deepseek-ai/dsh-host-apiproxy` is not migrated** — its tenant-administration RPC face still imports `@deepseek-ai/dsh-tenant` for the tenant record type, the default administrative scope, and error mapping, because that package's RPC method map is a static interface rather than a contribution point.
- **The partitionless code is a shared string.** `isPartitionlessFailure` matches the one code every partition-scoped backend raises; a backend that invents another code is not recognized, and nothing in the type system prevents that.
