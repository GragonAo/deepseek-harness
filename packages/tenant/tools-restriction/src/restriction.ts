/**
 * The restriction document a tool-tier directory may ship: the reserved file
 * names, a strict parse, and the expansion of its prefix patterns into exact
 * global tool names. A document is data only — it names global tools and carries
 * no capability of its own.
 * @module @deepseek-ai/dsh-tools-restriction/restriction
 */

import { parse } from 'yaml'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

/**
 * Basenames reserved for a tier's restriction document. A tier directory holds
 * at most one of them; `@deepseek-ai/dsh-tools-manifest` skips these names so a
 * manifest listing never parses a restriction document as a tool.
 */
export const RESTRICTION_FILE_BASENAMES = ['restriction.yaml', 'restriction.yml'] as const

/**
 * Whether one directory entry carries a tier's restriction document.
 * @param fileName - the entry's basename.
 * @returns true for a reserved restriction basename.
 */
export function isRestrictionFile(fileName: string): boolean {
  return (RESTRICTION_FILE_BASENAMES as readonly string[]).includes(fileName)
}

/**
 * Characters refused in an entry because they read as a pattern language. One
 * trailing `*` is the whole syntax: every other character is a literal part of a
 * tool name, so a document cannot express a regular expression, a character
 * class, or an alternation to review as if it were a name.
 */
const PATTERN_METACHARACTERS = ['?', '+', '[', ']', '(', ')', '{', '}', '|', '^', '$', '\\'] as const

/**
 * How many global tool names one entry may expand to. A prefix matching more is
 * a shortened name rather than a namespace — `mcp__*` in a `deny` list would
 * mask every server the deployment has, and in an `allow` list would admit them
 * all — so the expansion stops and names the entry instead of applying it. The
 * bound is not a deployment choice: it is where a prefix stops identifying a
 * group, above the largest group a mining server exposes by an order of
 * magnitude.
 */
export const MAX_EXPANDED_NAMES_PER_ENTRY = 512

/**
 * One declared entry of an `allow` or `deny` list, classified at parse time: an
 * exact global tool name, or a trailing-`*` prefix that becomes exact names when
 * the document is applied.
 */
export type RestrictionEntry =
  | { readonly kind: 'name'; readonly declared: string }
  | { readonly kind: 'pattern'; readonly declared: string; readonly prefix: string }

/**
 * One tier's parsed restriction document. Entries stay unexpanded because a
 * pattern can only be resolved against the names the registry holds, which is
 * the registry's state at the moment an agent is created rather than anything
 * the document itself carries.
 */
export interface RestrictionDocument {
  /** Exact names and prefix patterns that stay visible; everything else is removed. */
  readonly allow?: readonly RestrictionEntry[]
  /** Exact names and prefix patterns removed from visibility. */
  readonly deny?: readonly RestrictionEntry[]
}

/**
 * Parse one restriction document into the entries the plugin expands against the
 * live registry. `allow` keeps the listed inherited names visible and `deny`
 * masks listed names on top of it; a document that declares neither key is
 * rejected because it would narrow nothing, and every diagnostic names the
 * source file — including an entry that is neither a tool name nor a legal
 * pattern.
 * @param text - the document's UTF-8 contents.
 * @param file - the path reported in diagnostics.
 * @returns the parsed entries, still unexpanded.
 * @throws when the document is not a mapping holding `allow` and/or `deny` lists of legal entries.
 */
export function parseRestriction(text: string, file: string): RestrictionDocument {
  const parsed: unknown = parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: a restriction document must be a mapping with \`allow\` and/or \`deny\``)
  }
  const fields = Object.keys(parsed)
  const unknown = fields.filter(field => field !== 'allow' && field !== 'deny')
  if (unknown.length > 0) {
    throw new Error(`${file}: unknown field ${unknown.map(field => JSON.stringify(field)).join(', ')}; only \`allow\` and \`deny\` are read`)
  }
  if (fields.length === 0) {
    throw new Error(`${file}: declares neither \`allow\` nor \`deny\`, so it narrows nothing`)
  }
  const document: { allow?: readonly RestrictionEntry[]; deny?: readonly RestrictionEntry[] } = {}
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field]
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry === '')) {
      throw new Error(`${file}: \`${field}\` must be a list of non-empty tool names`)
    }
    const entries = (value as string[]).map(entry => classifyEntry(entry, file))
    if (field === 'allow') document.allow = entries
    else document.deny = entries
  }
  return document
}

/**
 * Classify one declared entry, refusing everything that reads as a pattern
 * language. `classifyEntry` is where the syntax is enforced: a document that
 * parses has entries the expansion can only interpret one way.
 * @param declared - the entry as the document wrote it.
 * @param file - the path reported in diagnostics.
 * @returns the entry as an exact name or a prefix pattern.
 * @throws when the entry carries a wildcard other than a trailing `*`, a metacharacter, or an empty prefix.
 */
function classifyEntry(declared: string, file: string): RestrictionEntry {
  const trailingStar = declared.endsWith('*')
  const literal = trailingStar ? declared.slice(0, -1) : declared
  if (literal.includes('*')) {
    throw new Error(`${file}: ${JSON.stringify(declared)} has a \`*\` that is not at its end; only a trailing \`*\` expands, as in \`mcp__icac-bill__*\``)
  }
  const metacharacter = PATTERN_METACHARACTERS.find(character => literal.includes(character))
  if (metacharacter !== undefined) {
    throw new Error(`${file}: ${JSON.stringify(declared)} contains ${JSON.stringify(metacharacter)}; every character but a trailing \`*\` is literal`)
  }
  if (!trailingStar) return { kind: 'name', declared }
  if (literal === '') {
    throw new Error(`${file}: ${JSON.stringify(declared)} expands from an empty prefix; name the namespace to expand, as in \`mcp__icac-bill__*\``)
  }
  return { kind: 'pattern', declared, prefix: literal }
}

/**
 * Expand one parsed document against the global tool names the registry holds
 * right now. Exact names pass through; a pattern becomes every held name that
 * starts with its prefix, so what reaches `tools.restrict()` is always a set of
 * exact names and the restriction mechanism itself is unchanged.
 *
 * A pattern matching nothing fails here instead of narrowing nothing: under an
 * `allow` a mistyped prefix would otherwise leave every tool visible, which is
 * the opposite of what the document declares, and under a `deny` it would read
 * as a mask that masks nothing.
 * @param document - the parsed tier document.
 * @param names - the registry's current global tool names.
 * @param file - the path reported in diagnostics.
 * @returns the exact-name restriction to apply.
 * @throws when a pattern matches no held name, or expands past {@link MAX_EXPANDED_NAMES_PER_ENTRY}.
 */
export function expandRestriction(document: RestrictionDocument, names: Iterable<string>, file: string): ToolRestriction {
  const held = [...names]
  const restriction: { allow?: readonly string[]; deny?: readonly string[] } = {}
  for (const field of ['allow', 'deny'] as const) {
    const entries = document[field]
    if (entries === undefined) continue
    const expanded = new Set<string>()
    for (const entry of entries) {
      if (entry.kind === 'name') {
        expanded.add(entry.declared)
        continue
      }
      const matched = held.filter(name => name.startsWith(entry.prefix))
      if (matched.length === 0) {
        throw new Error(`${file}: \`${entry.declared}\` matches none of the ${held.length} registered global tool${held.length === 1 ? '' : 's'} (${sampleOf(held)}); a prefix that matches nothing would leave \`${field}\` narrowing nothing`)
      }
      if (matched.length > MAX_EXPANDED_NAMES_PER_ENTRY) {
        throw new Error(`${file}: \`${entry.declared}\` expands to ${matched.length} global tools, over the ${MAX_EXPANDED_NAMES_PER_ENTRY}-name bound; state the namespace this entry means`)
      }
      for (const name of matched) expanded.add(name)
    }
    restriction[field] = [...expanded].sort()
  }
  return restriction
}

/**
 * A bounded, sorted sample of the held names, so a mistyped prefix shows the
 * namespaces that do exist next to the one the document asked for.
 * @param names - the registry's current global tool names.
 * @returns the first eight names, with an ellipsis when more remain.
 */
function sampleOf(names: readonly string[]): string {
  const sorted = [...names].sort()
  const shown = sorted.slice(0, 8).join(', ')
  return sorted.length > 8 ? `${shown}, …` : shown
}
