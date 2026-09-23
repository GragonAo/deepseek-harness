# Agent Note: Mounted plugin roots

Status: implemented

English | [中文](2026-09-23-mounted-plugin-roots.zh.md)

## Problem

A deployment that needs one more tool had to ship a new image: every plugin was an npm package the image installed, and a cordis row could only name one by bare specifier. The case-platform sync tools are a deployment artifact, not a product surface — they address one backend at one address, and the operator who needs them cannot rebuild the harness.

The Loader could already import an absolute path (`packages/boot/app-boot/src/index.ts` converts an absolute row name with `pathToFileURL`), and `scripts/verify-cordis-config.ts` exempts path specifiers from the resolver-manifest dependency gate. What was missing was a way to name a mounted plugin without an absolute path per row, and a load-time failure when the deployment's paths are wrong.

## Decision

`@deepseek-ai/dsh-plugin-roots` publishes a `pluginRoots` service built from a validated `Config.roots` list, and the root Include entry resolves a `local:` row through it.

The `local:` prefix is what separates the two specifier families. A bare name is always an installed package; a `local:` name is always a mounted directory. Nothing has to decide precedence between them, and a mounted plugin may take an installed package's name without ambiguity — the same deployment can mount a patched `@deepseek-ai/dsh-tools` directory and reach it as `local:@deepseek-ai/dsh-tools`.

The roots default to an empty list, and every configured root is validated when the row mounts. Loading a mounted directory runs its code, so the trust decision is the operator's to write down, explicitly, once per deployment; there is no directory scanning, no convention-based discovery, and no fallback to a package name.

A `local:` row with no roots service mounted above it fails with the instruction to add the row, rather than resolving against nothing.

## Alternatives considered

**Make the sync tools a published package.** Rejected by the operator's own constraint: every tool change would then need an image rebuild, and the address would have to reach a package the image ships rather than a file the deployment edits.

**Resolve a bare name against the roots before npm resolution.** Rejected: the precedence is invisible in the row, and the same name would mean different things in different deployments. The prefix makes the choice part of the name.

**Scan a well-known directory automatically.** Rejected: an implicit scan makes an untrusted directory executable by placement alone, and a dropped file would become running code with no configuration change to review.

**Skip an unresolvable reference and boot the rest.** Rejected: a silently absent tool is indistinguishable from a working one until the model calls it, which is exactly the failure an operator cannot debug.

**Put the roots list on the root Include entry's config.** Rejected: the root include is app glue created before any patch layer applies, so no mounted config file can reach it — the operator's own `cordis.patch.yml` is applied by the tree it configures.

## Consequences

A mounted plugin that imports harness packages needs those packages resolvable from its own directory. A root under `$DSH_HOME/profiles/<name>/` gets them from the launcher-maintained `$DSH_HOME/profiles/node_modules` fallback; any other root needs its own `node_modules`, and the failure is a module-resolution error naming the missing package.

The resolver reads the directory at load time, so replacing a mounted plugin's files takes a restart or an HMR reload rather than a config edit.

A deployment that mounts a `local:` row keeps the capability requirement: the running image must carry this package and the `local:` branch of the root Include. Adding tools afterwards does not.
