# `@deepseek-ai/dsh-plugin-roots`

English | [中文](README.zh.md)

Directories the Loader resolves mounted plugin code from. A cordis row names a mounted plugin with the `local:` specifier — `local:report-sync` — and this plugin turns that reference into the absolute entry file the Loader imports. The roots are the deployment's, so they are configuration; the default is an empty list, and nothing loads from disk that an operator did not name.

## Configuration

```yaml
- id: plugin-roots
  name: '@deepseek-ai/dsh-plugin-roots'
  config:
    roots:
      - /opt/.dsh/profiles/multi-tenant/plugins
- id: report-sync
  name: 'local:report-sync'
  config: {}
```

`roots` is ordered: the first root that provides a reference wins. The `plugin-roots` row must mount **above** every `local:` row that uses it; a `local:` row with no root configured fails the boot with that instruction.

## Resolving one reference

The text after `local:` is a path relative to a root. It may not be absolute and may not contain `..`. Inside the directory, the entry file is the one `package.json` declares — `exports["."]` (a string, or its `import` then `default` condition) then `main` — and otherwise the first of `index.ts`, `index.js`, `index.mjs`.

## The trust boundary

A mounted plugin is executable code, so the empty default is the security posture, not a convenience: the deployment names the directories it trusts, and only those are searched. There is no directory scanning, no convention-based discovery, and no fallback to a package name — a bare specifier never becomes a mounted reference, so a mounted plugin may share a name with an installed package without ambiguity.

## Failures

Every misconfiguration stops the boot and names what is wrong: a configured root that is missing or is not a directory (at mount), a reference no root provides (listing every directory searched), a manifest that is not JSON or declares a missing entry, and an absolute or escaping reference. Nothing is skipped silently.

## Model Experience

None: the plugin registers no tool, prompt section, or session event. It reaches the model only through the plugins it resolves, whose own contracts own their model-facing behavior.

## Known Limitations and Deferred Work

- A root outside the profile directory needs its own `node_modules` for a plugin that imports harness packages. A root under `$DSH_HOME/profiles/<name>/` resolves them through the launcher-maintained `$DSH_HOME/profiles/node_modules` fallback.
- The resolver reads the directory at load time; replacing a mounted plugin's files needs a restart or an HMR reload, not a config edit.
- `package.json` `exports` conditions are consulted in a fixed `import`-then-`default` order. A plugin that needs a different condition cannot express it here.
