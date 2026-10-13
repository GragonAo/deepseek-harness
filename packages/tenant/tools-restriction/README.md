# @deepseek-ai/dsh-tools-restriction

Declarative per-tier tool restriction for the multi-tenant carrier: every created agent applies the reserved `restriction.yaml` its case, user-global, and system tool-tier directories may ship to its own scope, through the tool registry's own restriction mechanism.

The registry removes a restricted name from that scope's visible map — the surface the assembled prompt, the generated `run_code` SDK declaration, and tool dispatch all read — so a case facing hundreds of data-mining MCP tools declares the few it actually uses. Both presentations and direct calls shrink with that declaration, which is what makes it the deployment lever for prompt cost rather than a decorative filter.

## The restriction document

A tier directory may hold one reserved `restriction.yaml` (or `restriction.yml`) listing global tool names and prefix patterns under `allow` and/or `deny`. Grouping follows the MCP servers themselves: one server per business group, so the groups a case type needs are the groups it lists.

```yaml
# A funds case: the case, bill, and persona groups — nothing else.
allow:
  - mcp__icac-case__query_case
  - mcp__icac-case__query_case_detail
  - mcp__icac-bill__*
  - mcp__icac-persona__query_persona
  - mcp__icac-persona__query_persona_tag
```

A trailing `*` is the only wildcard: `mcp__icac-bill__*` admits every `icac-bill` tool the registry holds, so a case type keeps a whole group without listing it one by one, while `mcp__icac-case__query_case_detail` beside it keeps a single tool. An operator-owned system document masks the write entry points of every group, and each case keeps narrowing inside what is left:

```yaml
deny:
  - mcp__icac-import__import_data
  - mcp__icac-import__delete_import
  - mcp__icac-ai-analysis__submit_query
```

`allow` lists the inherited names that stay visible and `deny` masks names on top of it, so a deployment that knows what a case needs writes `allow`, and one that only wants a few dangerous tools gone writes `deny`. `allow: []` is legal and hides every inherited tool. A document declaring neither key is rejected because it narrows nothing; an unknown field and a list item that is not a non-empty string are rejected too, as is a directory holding both `restriction.yaml` and `restriction.yml`.

**Write a case tier as `allow` with prefixes, and reserve `deny` for masking.** The two directions fail in opposite ways when a server later adds a tool: `allow` admits only what it names, so a new tool stays out until someone adds it (fail-closed), while `deny` masks only what it names, so a new tool arrives visible to every case (fail-open). A case that lists the groups it uses therefore cannot silently grow a tool list when a mining server ships new endpoints, and a group prefix keeps that document from having to list each tool the server exposes today. A `deny` document is the right tool for the opposite job — an operator masking operations that must not be reachable — and whoever writes one re-checks it when the far side adds tools.

A prefix is a literal string followed by `*` and nothing else: `mcp__*__search`, `?`, character classes, and regular expressions are rejected at load, naming the file and the entry. Exact names and patterns mix freely in one document, and both directions may use either. What reaches the registry is always exact names — the pattern expands against the global names the registry holds at the moment an agent is created, and the restriction mechanism itself is unchanged. A pattern matching no registered global name fails that creation and names the file and the pattern, because a mistyped prefix under an `allow` would otherwise leave every tool visible; one pattern expanding past 512 names is refused for the same reason.

Names are global tool names: an MCP tool is registered as `mcp__<serverName>__<rawName>`, and a name must be the exact one the server reports. Generate a case document once per case type from the group's `tools/list` (or from what an unrestricted agent currently sees) and reuse it for every case of the type; a name the registry does not have fails the creation of the agent that reads it and names the file. `run_code` is the reserved presentation transport rather than a capability, so a document cannot name it and it stays visible under the `code` and `both` presentations.

## How the three tiers compose

The documents intersect: an agent sees the intersection of its tiers' restrictions, which is the registry's own rule for more than one restriction on a scope chain. The tiers keep their tool-tier ranks (case < user-global < system), but a rank only orders which document is applied first and never lets a nearer tier re-admit what a farther one masked.

Intersection is the deliberate choice over letting the nearest tier that ships a document decide alone. The case directory is tenant-writable and the system directory is operator-owned, so an override would hand a tenant the power to re-admit a tool the operator removed, while intersection keeps that decision with the operator and still lets a case narrow further.

## Configuration

None: this plugin takes no tier roots, because `ctx.toolTiers` already resolves them from the tool-tier provider's `usersRoot` and `systemToolsDir` config plus the ambient tenant's `workspaceRoot`, and carrying a second set of roots would let the manifest loader and the restriction reader disagree about which directory a tier owns. Any config key is rejected at load.

Mounting this plugin after the tool-tier provider parses the system tier's document at load, where it needs no ambient tenant or user; without that provider the listener still registers and nothing is restricted. Every document is parsed again when an agent is created, so a malformed system document also fails the creation of each agent under it, whatever the composition does with a row's own load error.

Patterns expand in that same `agent/created` window, against the global names the registry holds at that moment: the registry's own `schemas()` view, minus the reserved `run_code` transport, which is not a restrictable name. Expansion is therefore per-agent rather than per-document — an agent created after a new MCP server connected sees the group that server added, and one created before it does not — and a tier's own manifest tools are never part of it, because those are registered into the agent's scope rather than globally. The expansion result is not written to the session log: it is the input to a filter over the tool list, not an input of its own to a model request, and the model-visible consequence — which names are absent — is already reconstructable from the schemas the registry serves. A syntax error in a pattern is reported at load for the system tier and at agent creation for the case and user-global tiers, like every other document error.

## Model Experience

### Removed tools

#### What the model sees

It contributes no text of its own: it removes tool names from what the model may choose. A restricted tool is absent from the native tool list and from the generated `run_code` SDK declaration, and calling it dispatches into `Error: unknown tool "<name>"`. A tier without a document, and every agent created while no tier directory ships one, sees the unrestricted set.

#### Token effect

Its effect is the negative of what the removed tools would have cost: each masked tool takes its own schema out of every request, and under the `code` or `both` presentation it also takes that tool's type declaration out of the SDK section. Nothing the restriction adds carries tokens.

#### KV Cache effect

The prefix is stable while the tier documents and the request's (tenant, user) scope are unchanged; editing a document, adding or removing one, or resolving agents under a different scope invalidates reuse from the first changed schema token, the same point at which registering or removing the tools it masks would.

## Known Limitations and Deferred Work

- **A document cannot name a tool that only a manifest contributes.** The registry filters the map a scope inherits, and the manifest loader registers tier tools into the agent's own scope, so such a name is reported as an unknown global tool and fails that agent's creation; a prefix matches global names only and cannot stand in for one. Hiding those tools means not shipping their manifest.
- **A pattern follows the registry, an exact name does not.** A tool that disappears from a group leaves every pattern silently narrower, while an exact name that disappears fails the next creation under that document. Keep a case document with the group it names and re-check it when a server changes its tool list.
- **Every created agent re-reads the tier documents.** Listing, parsing, and expanding are synchronous inside the `agent/created` window, which suits a handful of files; prewarming, caching, and an async `prepare()` are deferred as they are for the manifest loader.
- **The system tier's document decides for every tenant.** It applies to every case, so it may only name tools that exist for every tenant; it is also parsed at load, which reports the operator's own typo before the first session rather than at some case's agent creation.
- **Load-time parsing covers the system tier only.** The case and user-global roots need an ambient (tenant, user) to resolve, so their documents are reported when an agent is created under them.
