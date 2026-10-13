/**
 * Declarative per-tier tool restriction for the multi-tenant carrier.
 *
 * Reads the reserved `restriction.yaml` each ambient case, user-global, and
 * system tool-tier directory may ship and applies it to the scope of every
 * created agent through the tool registry's own `tools.restrict()`. The
 * registry removes a restricted name from the scope's visible map, which is the
 * surface the assembled prompt, the generated `run_code` SDK declaration, and
 * tool dispatch all read, so a tier declares which tools its agents may see
 * instead of paying for every registered one.
 *
 * A document may name a trailing-`*` prefix beside exact names, and each
 * creation expands those patterns against the names the registry holds at that
 * moment before applying the result, so a tier can admit a server's whole
 * namespace without listing every tool it exposes today.
 *
 * The three directories come from `ctx.toolTiers` — the provider
 * `@deepseek-ai/dsh-tools-tier` builds from its own config and the ambient
 * tenant — so both tier loaders read one set of roots. They are host paths
 * outside every tenant container: the case directory is tenant-writable and the
 * system directory is operator-owned, and since the registry intersects
 * restrictions, a case can narrow what the operator admits but never re-admit
 * what the operator masked.
 * @module @deepseek-ai/dsh-tools-restriction
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expandRestriction, isRestrictionFile, parseRestriction } from './restriction.ts'
import type { RestrictionDocument } from './restriction.ts'

/** Cordis plugin name. */
export const name = 'tools-restriction'

/** The registry whose per-scope restriction this plugin applies. */
export const inject = ['tools']

/** This restriction consumer has no config; the tier roots come from `ctx.toolTiers`. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

/**
 * Register the `agent/created` listener that applies every ambient tier's
 * restriction to the new agent's scope, and parse the system tier's document at
 * load, where it is already resolvable without an ambient tenant or user.
 * @param ctx - Cordis context carrying `tools` and (optionally) the ambient `toolTiers` provider.
 * @param config - must be empty; the tier roots belong to the tier provider.
 * @throws when a config key is present, or the system tier's document is invalid.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const [key] = Object.keys(config)
  if (key !== undefined) {
    throw new Error(`tools-restriction: unknown config key ${JSON.stringify(key)}; the tier roots come from the tool-tier provider`)
  }
  // Outside an ambient scope the provider resolves only the system tier, so the
  // operator's own document fails at load rather than at the first session of
  // the first tenant. Case and user-global documents need an ambient
  // (tenant, user) to resolve and are parsed when an agent is created.
  readRestrictions(ctx)
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    restrictAgent(ctx, agent)
  }, { global: true }), 'tools-restriction: agent tier restriction')
}

/** One tier directory's parsed restriction, with the file every diagnostic names. */
interface TierRestriction {
  file: string
  document: RestrictionDocument
}

/**
 * Apply each ambient tier's restriction to one created agent's scope, farthest
 * tier first. Every document's prefix patterns expand here, against the global
 * tool names the registry holds at creation, so what reaches the registry is a
 * set of exact names; the registry intersects those restrictions along the scope
 * chain, so the three documents compose into one narrowing and their order only
 * decides which file a diagnostic names.
 *
 * Both failures are rethrown with the document that caused them and never
 * swallowed: a pattern that matches nothing, and a name that no global
 * contribution registers, fail the agent's creation naming that file, instead of
 * surfacing later as a session failure or as an unexpectedly wide tool list.
 */
function restrictAgent(ctx: Context, agent: Agent): void {
  const names = restrictableGlobalNames(ctx)
  for (const { file, document } of readRestrictions(ctx)) {
    const restriction = expandRestriction(document, names, file)
    try {
      agent.ctx.tools.restrict(restriction)
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`)
    }
  }
}

/**
 * The global tool names a tier document may name, as the registry holds them at
 * this moment. `schemas()` without a scope reads the registry's own view, so it
 * lists the global registrations rather than one agent's scoped ones — a tier's
 * own manifest tool is not a restrictable name. The reserved Code Mode
 * transport is not one either, because `tools.restrict()` refuses to name it, so
 * it is not offered to an expansion.
 */
function restrictableGlobalNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name).filter(name => name !== RUN_CODE_NAME)
}

/**
 * Read and parse each ambient tier directory's restriction document, farthest
 * tier first. A tier without the reserved file narrows nothing.
 */
function readRestrictions(ctx: Context): TierRestriction[] {
  const roots = ctx.get('toolTiers')?.roots() ?? []
  const declared: TierRestriction[] = []
  for (const root of [...roots].sort((a, b) => b.rank - a.rank)) {
    const file = restrictionFileIn(root.path)
    if (file === undefined) continue
    declared.push({ file, document: parseRestriction(readFileSync(file, 'utf8'), file) })
  }
  return declared
}

/**
 * @returns the reserved restriction document in one tier directory, undefined
 * when the directory ships none, and throws when it ships more than one.
 */
function restrictionFileIn(dir: string): string | undefined {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const declared = entries
    .filter(entry => entry.isFile() && isRestrictionFile(entry.name))
    .map(entry => join(dir, entry.name))
    .sort()
  if (declared.length > 1) {
    throw new Error(`${dir}: holds ${declared.length} restriction documents (${declared.map(file => basename(file)).join(', ')}); a tier declares one`)
  }
  return declared[0]
}
