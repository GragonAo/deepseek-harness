# Agent Note: Optional chart-provided PostgreSQL

Status: implemented

English | [中文](2026-11-18-optional-chart-provided-postgresql.zh.md)

## Problem

The chart carried PostgreSQL only as connection coordinates: `middleware.database` held `host`, `port`, `name`, `user` and `password`, and [README §5](../../../deploy/helm/deepseek-harness/README.md) told operators that PostgreSQL is not created by this chart. Installing the chart on a cluster without a database therefore needed a second, undocumented procedure first, and until it finished the host sat in `CrashLoopBackOff` reporting connection refused.

That gap defeated the delivery unit the chart exists to provide. Copying the chart directory and the `dsh-tenant-host` image was not enough to install, because the one dependency every install needs still came from somewhere else. The raw manifests that had been used to create `dsh-pg` were also outside Helm's ownership: no upgrade path, no `app.kubernetes.io/*` labels, and nothing recording which release owns the objects.

## Decision

`middleware.database.provision` owns provisioning, beside the connection coordinates that stay in `middleware.database`. Connection and provisioning are separate groups because an operator can wire an existing database without adopting it, and create one without changing how the host reaches it.

`provision.create` defaults to `false`, which preserves the shipped behavior: the chart connects and renders nothing else. `true` renders `templates/pg.yaml`, which declares three objects:

- Deployment `dsh-pg`, with `strategy: Recreate` because the data volume is `ReadWriteOnce` and cannot float between pods.
- PersistentVolumeClaim `dsh-pgdata`, annotated `helm.sh/resource-policy: keep` so `helm uninstall` does not take the data with it.
- Service `dsh-pg` on `middleware.database.port`.

The resource names are fixed rather than derived from the release name. The tenant configuration resolves the Service through `middleware.database.host`, whose default is the literal `dsh-pg`; a release-derived name would make the default connection string wrong.

The password comes from `middleware.database.password`, or from `provision.existingSecret` when the site already keeps one. `create=true` with neither fails the render through `required`, so the chart cannot install a database with an empty password. The remaining deployment-varying choices are `provision.image`, `.storage`, `.storageClass`, and `.resources`; `values.schema.json` declares the group under `additionalProperties: false` so an unknown key is a validation error rather than a silently ignored setting.

Provisioning does not extend to application configuration. The chart owns processes, images, ports, disks and resources. Every setting the application reads is owned by Nacos, which is the single configuration source since the removal of `application-docker.yml`.

## Verification

`helm lint` passes on the chart. Default values render no `dsh-pg` object, confirmed by searching the rendered output for the three resource names.

`--set middleware.database.provision.create=true --set middleware.database.password=…` renders exactly three objects, and `kubectl create --dry-run=server` accepts all three against the 130 cluster (Kubernetes v1.28.2).

`--set middleware.database.provision.create=true` without a password fails the render with `middleware.database.password 必填（或改用 provision.existingSecret）`.

## Alternatives considered

**Always create, drop the flag.** A chart that unconditionally declares `dsh-pg` and `dsh-pgdata` reflects the common single-repository delivery best, and removes a mode that must be documented twice. It loses because 130 already runs an externally created `dsh-pg` under exactly those names with 48 days of data: an unconditional install would either collide on adoption or rewrite a production database's lifecycle, and every operator who manages PostgreSQL separately could no longer install the chart at all.

**A Bitnami-style PostgreSQL subchart.** `dependencies:` on a maintained chart would delegate image pinning, probes and upgrade sequencing to upstream, which is more than three objects' worth of maintenance saved. It loses on two counts: it adds a chart repository as an install prerequisite, and its values namespace would duplicate coordinates the site already sets in `middleware.database`, so one connection would be configured in two places.

**Keep the raw manifests and document the procedure.** This is what the repository did before. It loses because the manifests cannot be upgraded with the release, carry no ownership record, and give a second place where the database name and password live.

**Name the objects from the release.** Release-derived names would let two releases coexist in one namespace. It loses because `middleware.database.host` defaults to the literal `dsh-pg` and the tenant configuration embeds that value in its connection string; a release-derived Service name would silently break the default wiring.

## Consequences

The chart is self-contained for a greenfield install: one `--set` makes PostgreSQL part of the release, with the PVC, the Service, and the ownership labels the raw manifests lacked.

The cost is a second mode to keep true. `provision.create` must stay `false` in any site that manages PostgreSQL outside Helm, and the two modes cannot be mixed for one database: adopting an existing `dsh-pg` into a release whose values already set `create: true` requires `helm upgrade --take-ownership` and a storage class and volume size that match what is already bound.

`helm uninstall` leaves `dsh-pgdata` behind by design. Removing a site's data is an explicit `kubectl delete pvc` — an operator action the chart deliberately cannot perform.
