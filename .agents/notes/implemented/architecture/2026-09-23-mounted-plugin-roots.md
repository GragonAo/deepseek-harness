# Agent Note: Mounted plugin roots are not a capability

Status: implemented

English | [中文](2026-09-23-mounted-plugin-roots.zh.md)

## Problem

A deployment needs to add a plugin that speaks its own business system without rebuilding the harness image. Every plugin was an npm package the image installed, and a cordis row could name one only by bare specifier, so a deployment had no way to point a row at code it owns.

Two mechanisms could close that: a new capability mapping a short name onto a configured directory, or the Loader's existing path specifiers, which already resolve a `.`-prefixed row against `baseUrl`.

## Decision

Mounted plugins are registered with path specifiers. No capability was added.

`mountRootInclude` sets the Loader's `baseUrl` to the configuration file's directory, and `Tree.import` resolves a `.`-prefixed specifier against it, so a deployment writes a relative row and the plugin resolves beside the config rather than beside the process working directory:

```yaml
- insert:
    - id: tool-sync-file
      name: './plugins/tool-sync-file/index.mjs'
```

The plugin directory lives under the deployment's profile (`$DSH_HOME/profiles/<profile>/plugins/<name>/`) because a mounted plugin that imports harness packages resolves them through Node's upward `node_modules` walk, which reaches the launcher-maintained `$DSH_HOME/profiles/node_modules` fallback only from inside the profile. Measured on the deployment host: an entry under the profile's `plugins/` resolves `@deepseek-ai/dsh-tools`; the same file under `$DSH_HOME/plugins/` fails with `ERR_MODULE_NOT_FOUND`.

`packages/boot/app-boot/tests/mounted-plugins.spec.ts` guards it: a real composition whose root config carries a relative row mounts the plugin and its tool registers, the row resolves beside the configuration file rather than the working directory, and a row naming a directory or a missing file fails the boot with the path.

## Alternatives considered

**A `plugin-roots` capability with a `local:` prefix and a configured root list.** Built, covered by 18 cases, then removed. It worked, but the path specifier already covers the case with no new surface: the capability added a service, a specifier namespace, a root-resolution algorithm, and a package with its own README, invariant companion, and tests, all to produce a string that `new URL(name, baseUrl)` produces on its own. A mechanism with no consumer is a maintenance cost, and every abstraction is required to have a current one.

Its one real advantage was brevity: `local:report-sync` is shorter than `./plugins/report-sync/index.mjs`, and it cannot collide with an installed package name because a bare name can never begin with `local:`. The relative path keeps the same guarantee by construction — a bare specifier is never a path — at the cost of spelling out the entry file.

**Resolve a bare name against a mounted directory before npm resolution.** Rejected: the precedence is invisible in the row, and the same name would mean different things in different deployments.

**Scan a well-known directory automatically.** Rejected: an implicit scan makes an untrusted directory executable by placement alone.

## Consequences

A deployment that mounts a plugin states its entry file path in full, and the row's meaning depends on the configuration file's own directory: moving the config moves the plugin's resolution with it.

The `.`-prefixed branch of `mountRootInclude` is now the whole mechanism, so the regression test above is what keeps it honest. An absolute-path row additionally depends on the launcher supplying a bare-module base, which is why that test covers the relative form.

Business integration therefore lives entirely outside `packages/`: the harness ships the Loader's path resolution, and the deployment ships the code that resolution finds.
