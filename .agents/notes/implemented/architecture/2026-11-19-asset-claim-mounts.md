# Agent Note: Asset claim mounts for sources outside the workspace claim

Status: implemented

English | [中文](2026-11-19-asset-claim-mounts.zh.md)

## Problem

A claim-mode `container-k8s` deployment projected every sandbox mount through one claim (`workspaceClaim`) rooted at `claimRoot`. That claim belongs to the workspace tree: tenants create and delete directories in it, and its lifetime follows theirs. Two mount sources do not share that lifetime — the Python runtime (`pythonRoot`) and the global system tree (`systemRoot`) are shared by every tenant of a deployment, run to hundreds of megabytes, and must survive a tenant being deleted. Keeping them in the workspace claim means either seeding a copy per deployment or losing them whenever that claim is replaced.

A second claim is the natural home, but `sandboxMounts` derived `claimName` and `subPath` from that single config pair, so no mount could read from another claim. The only escape was `hostPath`, which pins every sandbox to one node.

## Decision

`Config.assetMounts` is a list of `{ source, claim, subPath }`. Each entry names a mount source by exact path; when `sandboxMounts` emits that source, the mount takes the entry's claim and `subPath` instead of the workspace claim's. The sandbox path and the read-only flag are unchanged, so a sandbox sees the same layout whether a layer is served by the workspace claim or an asset claim.

Validation splits by what is knowable when. At load the provider rejects a relative `source`, an empty `claim`, a `subPath` that is empty, absolute, or contains `..`, the same source listed twice (compared after stripping a trailing slash, which `posix.normalize` preserves), and any `assetMounts` without `workspaceClaim` + `claimRoot` — hostPath mode has nothing to project onto. Which sources a tenant actually has is only known per tenant, so the entry-to-source match is checked when the mount table is built: an entry naming a path that is not a source throws and names it rather than being silently ignored.

`tenant-app` reads the same field (`assetMounts` in the `sandbox` section) into its k8s sandbox type and passes it through unchanged. That reader fails loudly on unknown fields, so the field had to be added there in the same change; the reader validates only that each entry is an object with the three non-empty keys, and leaves the path rules to the provider.

## Alternatives considered

**A second `claim` + `root` pair covering the whole asset tree.** Two roots only describe deployments whose entire mount table lives on one side or the other; `/case` and the user-global tree stay on the workspace claim while the runtime and system tree move, so a per-source table is needed anyway — and the pair form is exactly what this replaces.

**Mount the asset claim at a different in-sandbox path and point `pythonRoot`/`systemRoot` at it.** The mount table's premise is that a source's host path and its sandbox path are the same string (`systemRoot` mounts at its own path, and the skill tier reads a subdirectory of it). Changing the sandbox path per layer would make every configured root lie about where it is, and would no longer mean the same thing as `container-docker`.

**Leave `hostPath` as the way to share a runtime across tenants.** It requires every sandbox to run on the node holding that directory, which is what claim mode exists to remove; on a multi-node cluster it fails by scheduling rather than by configuration.

## Consequences

The runtime and the system tree become deployment-level assets with their own claim, so deleting a tenant cannot reach them and each claim keeps its own reclaim policy.

The provider checks only the claim *name* an entry declares; nothing can verify that the host Pod mounts that same claim. A wrong name therefore surfaces as an empty or missing directory inside a running sandbox, not as a load error. Deployments must keep `assetMounts[].claim` in step with the volume they mount.

Moving existing content from the workspace claim to the asset claim is an offline migration the provider does not perform: copy the tree, then add the entries.

`tenant-app` carries the field, so the k8s config surface is one field wider and `container-docker` deliberately does not offer it — a docker deployment cannot project a `subPath` onto a claim.

## Testing

`packages/tenant/container-k8s/tests/asset-mounts.spec.ts` pins the projection (matched source takes the asset claim and subPath, unmatched sources keep the workspace claim), the trailing-slash-insensitive duplicate rule, and each load-time rejection. `packages/tenant/tenant-app/tests/app.spec.ts` pins the reader: both entries parse, and a misspelled entry field is refused.