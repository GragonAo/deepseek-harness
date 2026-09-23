/**
 * Directories the Loader resolves mounted plugin code from.
 *
 * A cordis row names a mounted plugin with the {@link LOCAL_PLUGIN_PREFIX}
 * specifier — `local:report-sync` — and this plugin turns that reference into
 * the absolute entry file the Loader imports. The roots themselves are this
 * deployment's, so they are configuration, and an empty list is the default:
 * nothing is ever loaded from disk that an operator did not name.
 *
 * Every configured root is validated when the row mounts, and an unresolvable
 * reference names the roots searched, so a mistyped path stops the boot instead
 * of leaving a tool silently absent.
 * @module @deepseek-ai/dsh-plugin-roots
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** The plugin name reported to the Loader. */
export const name = 'plugin-roots'

/** No service is required to publish the roots; the resolver is built from configuration alone. */
export const inject: readonly string[] = []

/** Mounted plugin roots configuration. */
export interface Config {
  /**
   * Absolute directories searched, in order, for a mounted plugin reference.
   * Empty (the default) resolves no reference: loading executable code from a
   * directory is a trust decision only the deployment can make.
   */
  roots?: string[]
}

/** Schemastery configuration for the mounted plugin roots. */
export const Config: z<Config> = z.object({
  roots: z.array(z.string()).default([]),
})

/** The configuration after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/**
 * The specifier prefix marking a mounted plugin reference. A bare specifier is
 * never read as one, so a mounted plugin can share a name with an installed
 * package without ambiguity.
 */
export const LOCAL_PLUGIN_PREFIX = 'local:'

/** Entry filenames tried inside a reference directory when no manifest names one. */
const ENTRY_FILENAMES = ['index.ts', 'index.js', 'index.mjs'] as const

/** Package-manifest fields consulted for the entry file, in order. */
const MANIFEST_ENTRY_FIELDS = ['exports', 'main'] as const

/** Resolution of mounted plugin references against this deployment's roots. */
export interface PluginRoots {
  /** The configured roots, absolute, in search order. */
  readonly roots: readonly string[]
  /**
   * Resolve one reference to the absolute entry file the Loader imports.
   * @param reference - the text after {@link LOCAL_PLUGIN_PREFIX}, relative to a root.
   * @returns the absolute path of the entry file.
   * @throws when no root provides the reference, naming every directory searched.
   */
  resolve(reference: string): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mounted plugin roots; provided by a `plugin-roots` row. */
    pluginRoots?: PluginRoots
  }
}

/**
 * Reject a reference that cannot name a directory inside a root, so a mistyped
 * or escaping path fails with its own reason instead of a search report.
 * @param reference - the text after {@link LOCAL_PLUGIN_PREFIX}.
 */
function assertReference(reference: string): void {
  if (reference === '') {
    throw new Error(`plugin-roots: ${LOCAL_PLUGIN_PREFIX} needs a name after the prefix`)
  }
  if (isAbsolute(reference)) {
    throw new Error(`plugin-roots: ${JSON.stringify(reference)} is absolute; a mounted plugin reference is relative to a configured root`)
  }
  if (reference.split(/[/\\]/u).includes('..')) {
    throw new Error(`plugin-roots: ${JSON.stringify(reference)} escapes its root; a mounted plugin reference may not contain ".."`)
  }
}

/**
 * Read the entry file a package manifest declares.
 * @param manifestPath - absolute path of the reference directory's `package.json`.
 * @returns the declared entry, relative to the manifest, or `undefined` when it declares none.
 * @throws when the manifest is not JSON.
 */
function manifestEntry(manifestPath: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    throw new Error(`plugin-roots: ${manifestPath} is not valid JSON`, { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const manifest = parsed as Record<string, unknown>
  for (const field of MANIFEST_ENTRY_FIELDS) {
    const declared = manifest[field]
    if (typeof declared === 'string') return declared
    if (field !== 'exports' || typeof declared !== 'object' || declared === null) continue
    const rootExport = (declared as Record<string, unknown>)['.']
    if (typeof rootExport === 'string') return rootExport
    if (typeof rootExport !== 'object' || rootExport === null) continue
    const conditions = rootExport as Record<string, unknown>
    for (const condition of ['import', 'default']) {
      const value = conditions[condition]
      if (typeof value === 'string') return value
    }
  }
  return undefined
}

/**
 * Find the entry file of one candidate directory.
 * @param dir - the absolute candidate directory.
 * @returns the absolute entry file, or `undefined` when the directory is absent or holds no entry.
 * @throws when the directory has a manifest declaring an entry that does not exist.
 */
function entryIn(dir: string): string | undefined {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined
  const manifestPath = join(dir, 'package.json')
  if (existsSync(manifestPath)) {
    const declared = manifestEntry(manifestPath)
    if (declared !== undefined) {
      const candidate = resolvePath(dir, declared)
      if (!existsSync(candidate)) {
        throw new Error(`plugin-roots: ${manifestPath} declares entry ${JSON.stringify(declared)}, which does not exist`)
      }
      return candidate
    }
  }
  for (const filename of ENTRY_FILENAMES) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Validate the configured roots and build their resolver.
 * @param roots - the configured roots, in search order.
 * @returns the resolver the Loader reads through `ctx.pluginRoots`.
 * @throws when a configured root is missing or is not a directory.
 */
export function createPluginRoots(roots: readonly string[]): PluginRoots {
  const absolute = roots.map((root) => {
    const dir = resolvePath(root)
    if (!existsSync(dir)) {
      throw new Error(`plugin-roots: configured root ${JSON.stringify(root)} does not exist (resolved to ${dir})`)
    }
    if (!statSync(dir).isDirectory()) {
      throw new Error(`plugin-roots: configured root ${JSON.stringify(root)} is not a directory (resolved to ${dir})`)
    }
    return dir
  })
  return {
    roots: absolute,
    resolve(reference) {
      assertReference(reference)
      const searched = absolute.map(root => join(root, reference))
      for (const dir of searched) {
        const entry = entryIn(dir)
        if (entry !== undefined) return entry
      }
      throw new Error(
        `plugin-roots: no configured root provides ${JSON.stringify(reference)}; searched ${searched.join(', ')}`,
      )
    },
  }
}

/**
 * Publish this deployment's mounted plugin roots.
 * @param ctx - plugin context; the service is an effect scoped to this plugin.
 * @param config - validated plugin configuration from schemastery.
 */
// oxlint-disable-next-line typescript/require-await -- async keeps a load-time config rejection a rejection, not a synchronous throw
export async function apply(ctx: Context, config: Config): Promise<void> {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  ctx.provide('pluginRoots', createPluginRoots(resolved.roots))
}
