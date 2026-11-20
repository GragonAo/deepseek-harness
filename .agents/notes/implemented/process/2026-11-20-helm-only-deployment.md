# Agent Note: Deployment is helm plus hand-typed commands, not a script kit

Status: implemented

English | [中文](2026-11-20-helm-only-deployment.zh.md)

Supersedes the deployment-scripting assumptions of [Deployment provider registry](../architecture/2026-11-07-deployment-provider-registry.md) where they overlap; that record still describes the runtime registry, not how a cluster is rolled out.

## Problem

Five repositories shared a deployment kit: a `deploy-kit` checkout of shell entry points, per-site env files, a chart-to-site key map, an image lock file, and verify wrappers. It drifted from the charts it drove. `helm-site-map.txt` named values keys that charts had renamed; `images.lock` pinned tags that no chart default matched; the verify wrappers ran `kubectl diff` against objects whose names existed only in a site env file. The effect on a machine that had never been deployed was always the same: someone followed the docs, the wrappers ran a chain of `helm` calls nobody could read, and the failure surfaced thirty seconds into a pod start rather than before the first `helm upgrade`.

Two concrete costs, both observed:

- The wrappers hid which chart version, which values file, and which `--set` produced a release. Reproducing a running cluster meant reading shell to reconstruct a command line.
- Deleting a wrapper deleted knowledge. Docs kept pointing at `sync-nacos-config.sh`, `ceph-s3-secret.sh`, `up.sh`, `deploy.sh` long after the files were gone, so the documented path was a dead end and the real path lived in one person's terminal history.

The kit was also the reason chart defaults could stay wrong: with a wrapper always passing `--set`, no one noticed that `config.tenantConfig.volumeKind` defaulted to a kind the chart never created (see [Tenant config is a Secret the deployment owns](../architecture/2026-11-20-tenant-config-secret-by-default.md)).

## Alternatives considered

- **Keep the kit and resynchronise it with the charts.** Rejected: the failure mode is drift, and drift is not fixed by one more sync pass. It also keeps two sources of truth for a single `helm upgrade` invocation.
- **Replace it with a per-repo `Makefile` / `Taskfile`.** Rejected: same shape, smaller hiding place. A task named `deploy` still conceals the arguments, and the repos would diverge again per team habit.
- **Move to a GitOps controller (Argo CD / Flux) rendered from charts.** Rejected for now: it is the right long-term shape, but it needs a controller, a repo layout, and a credential story that this environment does not have. Also, the immediate problem was comprehension, not automation.
- **Keep the scripts but generate their arguments from the charts.** Rejected: generation fixes the argument list and leaves the wrapper, so the command that actually ran is still invisible on the machine.

## Decision

`deploy-kit` is deleted from every repository. Deployment is:

- **Materials on the target machine**, one directory per version: `/opt/icac-ai-helm/<version>/{charts,values,images,nacos-config,assets}`. Charts are the repositories' own `deploy/helm/*` directories; nothing is transformed in between.
- **Per-site values live only on the machine**, mode 600, never in git. A site's real tokens and passwords have no representation in a repository.
- **The documented path is command blocks a human types**: `ctr -n k8s.io images import`, `helm upgrade --install … --take-ownership --wait`, `kubectl rollout restart`, Nacos console zip import. Each line states its own flags, so the release is reproducible by reading it.
- **Chart defaults must stand on their own.** A fresh environment with no `--set` must either work or fail at render time, never at pod start. That is why the tenant config volume default was corrected in the same change.

Documentation that used to name a script now names the action and its key material — for example object-storage credentials are described by their key names (`CEPH_S3_ACCESS_KEY` / `CEPH_S3_SECRET_KEY`) instead of by the script that once created the Secret.

## Consequences

- Rolling out a version is five typed commands per release, done by an operator who can see every flag. There is no `deploy.sh` to run, and no `--atomic` (a failed first install would uninstall objects the release had adopted).
- Image transfer has no automation: the documented loop is `sha256sum -c` then `ctr images import`, because the cluster has no registry reachability.
- Chart defaults are now load-bearing. A wrong default is discovered by whoever deploys a new environment, so defaults get the scrutiny that wrappers used to hide.
- Every repository document must stand alone: no cross-repo path may be referenced as if it were on the reader's disk. The recurring review question is "would this sentence be usable on a machine that has only these repos?"

## References

- [Tenant config is a Secret the deployment owns](../architecture/2026-11-20-tenant-config-secret-by-default.md)
- [Whole-claim asset mounts](../architecture/2026-11-20-whole-claim-asset-mount.md)
- [Chart README: install, upgrade, tenant config](../../../../deploy/helm/deepseek-harness/README.md)