# Agent Note: Whole-claim asset mounts

Status: implemented

English | [中文](2026-11-20-whole-claim-asset-mount.zh.md)

Partially supersedes [Asset claim mounts for sources outside the workspace claim](2026-11-19-asset-claim-mounts.md): the per-source table stays, but the pair form it rejected is now the way a deployment mounts its whole asset tree.

## Problem

`Config.assetMounts` mounts one source per entry, and each entry's `subPath` must be a non-empty path inside the claim. A deployment that keeps its shared assets at the root of one claim therefore cannot describe them: there is no entry that means "this claim, as it is". It had to name each layer separately (`system`, `pyenv`), which put the volume's internal layout in two places at once — the chart's values and the program's `systemRoot` / `pythonRoot` — with nothing checking that the two agree. The deployment this code serves wanted the opposite: mount the shared volume whole, read-only, and let the program's own config say which directories inside it matter.

## Decision

`Config.assetsClaim` and `Config.assetsRoot` mount one claim, whole, at one path. The mount is read-only and carries no `subPath`; which directories inside it exist is the deployment's business, expressed by `systemRoot` and `pythonRoot` pointing into `assetsRoot`.

`sandboxMounts` then drops a source from the ordinary table when the source *is* its own mount path and sits inside `assetsRoot` — such a layer is already visible through the whole-volume mount, and mounting it again would put one copy of the data at two paths. Sources that live elsewhere keep their own mount; the skill tier's aggregate root (`/opt/data/skills/system`) is the live example, and its projection takes `subPath: system/skills` relative to the volume root. The whole-volume entry sorts first so that the aggregate root's local parent directory is still created ahead of it.

Load-time checks extend the ones `assetMounts` already has: the two fields are set together or not at all, `assetsRoot` is absolute and its claim non-empty, claim mode is required, and `assetsRoot` and `claimRoot` may not contain each other — an asset volume placed inside the workspace claim would be deleted with a tenant.

## Alternatives considered

**A second `claim` + `root` pair covering the whole asset tree, without the per-source table** — the form the 2026-11-19 note rejected. Alone it is still wrong for the reason given there: `/case` and the user-global tree stay on the workspace claim, so a per-source table is needed anyway. What that note did not need, and this deployment does, is a way to mount a claim *as a whole*; the two mechanisms coexist.

**Allow an empty `subPath` in `assetMounts`.** `subPath: ''` is not a neutral value: it reaches the pod spec as a literal empty string, which kubelet resolves as a subdirectory that does not exist. Rejecting it stays.

**Mount the whole volume writable.** Nothing in the runtime path writes to it; a read-only mount turns an accidental write into a loud error instead of silent pollution of a volume shared by every tenant. The one legitimate writer is the platform's system-skill installer, which the chart mounts separately and writably — a deployment choice, not a provider one.

## Consequences

The provider no longer needs to know the volume's layout, so a layout change is a program-config change. The trade is that a wrong `assetsRoot`, or a volume that lacks the directories the program names, is only visible when something reads them: the mount itself always succeeds, because a claim mounted without `subPath` has no missing-source signal.

Pairing is enforced at load and again in `sandboxMounts`, so a config that names only one of the two fields fails where it is written rather than at the first sandbox.

`container-docker` keeps no equivalent: it mounts host directories one at a time and has no claim to mount whole.

## Testing

`packages/tenant/container-k8s/tests/asset-mounts.spec.ts` pins the whole-volume mount (one entry, read-only, no `subPath`), the absence of the same-path layers, the aggregate root's relative `subPath`, the untouched workspace-claim layers, and each load-time rejection. `packages/tenant/tenant-app/tests/app.spec.ts` pins the reader that carries the two fields through.