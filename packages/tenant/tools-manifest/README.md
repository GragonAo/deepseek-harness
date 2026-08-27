# @deepseek-ai/dsh-tools-manifest

English | [中文](README.zh.md)

Turns the multi-tenant carrier's ambient tool directories into tools without accepting any executable code. For every `agent/created` event, the plugin reads the case, user-global, and system roots supplied by `ctx.toolTiers`, parses each `*.yaml` / `*.yml` as a data-only manifest, and registers the declared tool in the created agent's own scope at that root's rank — case (`30`) shadows user-global (`40`), which shadows system (`50`), and distinct names union. Because the registry's ranked `register` shadows same-named native tools while an unregistered scope holds no ambient names, the system tier can also override a built-in tool of the same name.

A manifest maps onto exactly one fixed executor family: a subprocess launched through `ctx.subprocess` — the tenant container in the multi-tenant carrier — whose argv is the manifest's `executor.args` template with `$field` placeholders substituted from the validated string arguments. There is no script host, no module import, and no `execute` body in the file: the declarative fields are the only inputs, and the command runs inside the tenant container, so a tenant-authored case manifest cannot escape isolation. Output is a bounded string; by default the command's stdout is returned verbatim and a non-zero exit fails the tool.

## Manifest format

One YAML document per tool, with a kebab-case name, a description, flat string parameters, and a fixed executor:

```yaml
name: mytool
description: short summary the model reads for tool selection
parameters:
  query:
    type: string        # the only supported type: flat string scalars
    description: what the argument means
    required: true
timeoutMs: 30000        # optional; per-call tool timeout
executor:
  command: /usr/bin/tool
  args: ["--query", "$query"]
  cwd: /workspace       # optional; falls back to the loader's defaultCwd
  env:                  # optional; string values only
    TOOL_MODE: batch
```

`$field` placeholders in `executor.args` are replaced by the corresponding string argument; a referenced argument the model did not supply substitutes an empty string, but a `required` parameter is validated before execution.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-tools-manifest'
  config:
    maxOutputBytes: 1000000  # optional; bounded stdout/stderr captured per call
    graceMs: 5000           # optional; process-tree termination grace per call
    defaultCwd: /workspace  # optional; cwd when a manifest omits executor.cwd
```

## Model Experience

### Registered tools

#### What the model sees

One tool per manifest enters the assembled tool list as any registered tool does: its `name`, `description`, and flat-string `parameters` become the schema the model reads for selection and invocation, while `timeoutMs` stays a deployment budget, not a model argument. Distinct manifest names across the three tiers union into the catalog, and a name shared across tiers resolves once to the nearest tier (case over user-global over system) at the tier rank.

#### Token effect

Fixed schema cost per registered manifest tool per request, linear in the number of manifests the current (tenant, user) tiers resolve; changing which tier directories exist, or which manifests they hold, changes the assembled tool list.

#### KV Cache effect

Prefix-stable while the merged tier manifests and the request's (tenant, user) scope are unchanged; editing a manifest or resolving under a different scope invalidates reuse from the first changed schema token.

### Tool result

#### What the model sees

The command's stdout, truncated to the loader's `maxOutputBytes`, is rendered as one `text` block through the tool's `render`.

#### Token effect

Data-dependent and resent until compaction; the byte cap bounds a single call's emitted text.

#### KV Cache effect

Append-only; the result follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool failure

#### What the model sees

A non-zero exit renders `Error: tool "<name>" exited <code>: <stderr-tail>` as the failed call's result, where the stderr tail is omitted when empty.

#### Token effect

Only the retained error text adds tokens; nothing else from the failed call enters history.

#### KV Cache effect

Append-only; the failure follows the reusable request prefix.

## Known Limitations and Deferred Work

- **Flat string parameters only.** Parameter values reach the command as `$field` argv substitutions, so no richer ValueSchemaSpec shape (numbers, enums, arrays) is expressible in this version.
- **Manifests are re-read per agent creation.** The tier directories are read synchronously inside the `agent/created` hook; this is fine for a small set of manifests but an async `prepare()` warm-up and cache are deferred.
- **Within one tier directory a duplicate name still fails loud.** Ranked shadowing resolves a name shared across tiers, but two manifests in the same directory must keep distinct names.
- **Credentials do not belong in manifests.** Declarative manifests hold no credential surface; the operator provisions any command-line secret through the provider, never through a tier manifest file.