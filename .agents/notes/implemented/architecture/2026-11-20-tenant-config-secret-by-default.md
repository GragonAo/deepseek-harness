# Agent Note: Tenant config is a Secret the deployment owns

Status: implemented

English | [中文](2026-11-20-tenant-config-secret-by-default.zh.md)

## Problem

The chart mounts the tenant config body at `/etc/dsh/tenant.config.yaml` through `config.tenantConfig.volumeKind`, which defaulted to `configMap` — the kind of a ConfigMap that predates this chart. The object the chart itself creates for that body is a Secret, so a deployment that omitted the flag asked for a ConfigMap nobody creates and the pod never started: `MountVolume.SetUp failed for volume "config" : configmap "dsh-tenant-config" not found`. Rendering succeeded, so nothing failed until a cluster ran it; the 130 deployment of v1.0.30 hit exactly this.

The body has a second, independent failure mode. Production cannot let the chart own it — `mcpServers` entries carry real tokens that `applyEnvOverrides` never supplies, so a chart-owned body would be overwritten with repository placeholders on every upgrade. The deployment therefore keeps its own copy, and that copy is frozen at whatever version created it. v1.0.30 added a required section (`plugins.tool-skill-publish.config.record`), so a body carried over from v1.0.24 loaded as `配置有误` / `invalid config: $.record missing required value (at record)` — a schema mismatch dressed as a mount or credentials problem.

## Decision

`config.tenantConfig.volumeKind` defaults to `secret`: both the chart-created object and the deployment-maintained one are Secrets, so the default now matches what a fresh install gets. A site that really keeps its body in a ConfigMap sets `configMap` explicitly (the schema still accepts it).

Production keeps the body out of the chart: `secrets.tenantConfig.create: false` plus `secrets.tenantConfig.existingSecret` naming a Secret the deployment maintains (`dsh-tenant-config-live` at 130). Helm neither creates nor updates it.

Because that body now evolves outside the chart, the chart README carries the merge recipe rather than a replace recipe: render the release's own body with `create=true` **and** `middleware.database.password`, keep the new structure, and take each value the new body leaves as a placeholder or empty from the previous body. Rendering without the password yields `postgres://dsh:@dsh-pg:5432/dsh`, which fails later as `SASL: client password must be a string` — one more failure that belongs to the values, not to the mount.

## Alternatives considered

- **Keep the `configMap` default and require `--set` everywhere.** That is what the README said before. Rejected: the mismatch renders fine and only fails on a cluster, so every new environment has to remember a flag whose absence produces an error message about a missing object rather than about the flag.
- **Make `volumeKind` required with no default.** The schema already requires the key, but Helm validates coalesced values, so the chart's own default always satisfies it; a required key with no default is not expressible here. Rejected as no-op.
- **Keep the body chart-owned and pass the real tokens in.** Rejected: tokens would move into site values files, and the body would still be replaced wholesale on every upgrade, discarding whatever the deployment had corrected by hand.

## Consequences

- A new deployment needs no `--set` for the volume kind; a ConfigMap-based site must say so.
- A version that adds a required body section requires the deployment to merge its body — the chart cannot do it, and the failure is a startup refusal naming the missing key.
- The body's real tokens stay on the machine that runs the cluster; the repository keeps placeholders only.

## References

- [Chart README: 租户配置来源](../../../../deploy/helm/deepseek-harness/README.md)
- [Whole-claim asset mounts](2026-11-20-whole-claim-asset-mount.md) — the other volume this chart mounts from a claim rather than from the chart