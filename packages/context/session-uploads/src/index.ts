/**
 * Model-visible inventory of the files a deployment writes into a session's
 * uploads directory.
 *
 * A business frontend uploads a document into the session directory before or
 * during a turn and sends the model a prompt that mentions no file name, so the
 * model cannot know what arrived. This plugin reads that directory on every
 * assembly and contributes the inventory as dynamic runtime context: the model
 * sees the current file list, and the session log records the snapshot it saw.
 *
 * @module @deepseek-ai/dsh-session-uploads
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { DEFAULT_DIRECTORY, DEFAULT_MAX_ENTRIES, renderUploads } from './listing.ts'

/** Plugin name under which this package registers its `system-prompt/assemble` listener. */
export const name = 'session-uploads'

/** The inventory reads `ctx.fs` and contributes to assemblies of `ctx.systemPrompt`. */
export const inject = ['fs', 'systemPrompt']

/** Name of the runtime-context contribution the inventory arrives in. */
export const CONTEXT_NAME = 'context:session-uploads'

/** Uploads-inventory configuration. */
export interface Config {
  /**
   * Directory inside the session's own directory that holds uploaded files
   * (default `uploads`). A relative name resolves against the session directory
   * the filesystem provider exposes, so the same value addresses
   * `<session>/uploads` on every workspace root.
   */
  directory?: string
  /** Maximum entries the listing prints before it summarizes the rest as a count (default 40). */
  maxEntries?: number
}

/** Validated uploads-inventory configuration. */
export const Config: z<Config> = z.object({
  directory: z.string().default(DEFAULT_DIRECTORY),
  maxEntries: z.number().step(1).min(1).default(DEFAULT_MAX_ENTRIES),
})

/** Configuration after defaults are resolved. */
interface Settings {
  directory: string
  maxEntries: number
}

/**
 * Contribute the current uploads inventory to every assembly that belongs to a
 * session. The listener runs its own read before delegating, so a session with
 * no uploads directory adds nothing and an unusable directory name fails at
 * load rather than on the first turn.
 * @param ctx - context carrying `fs` and `systemPrompt`.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() supplies both fields before `apply` sees them.
  const settings: Settings = {
    directory: config.directory as string,
    maxEntries: config.maxEntries as number,
  }
  assertRelative(settings.directory)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const inventory = await readInventory(ctx, settings, context)
    const result = await next()
    if (inventory.length === 0) return result
    return { ...result, contexts: [...result.contexts, { name: CONTEXT_NAME, text: inventory }] }
  })
}

/**
 * Read and render the session's uploads directory.
 * @param ctx - context carrying `fs`.
 * @param settings - resolved configuration.
 * @param context - the assembly requesting the inventory.
 * @returns the listing, or `''` when the session has no uploaded files.
 */
async function readInventory(
  ctx: Context,
  settings: Settings,
  context: AssembleContext,
): Promise<string> {
  const agent = context.agent
  // A scope-only assembly (a cold read, a diagnostic) has no session directory.
  if (agent === undefined) return ''
  const cwd = agent.session.header.cwd
  const signal = context.signal
  const options: { cwd?: string; signal?: AbortSignal } = {}
  if (cwd !== undefined) options.cwd = cwd
  if (signal !== undefined) options.signal = signal
  try {
    // The provider resolves a relative name against the session directory when
    // it serves one, which is how a container-mounted workspace addresses the
    // same uploads directory a shell command in that session reaches.
    const target = await ctx.fs.resolve(settings.directory, options)
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined || info.type !== 'directory') return ''
    return renderUploads(await ctx.fs.listDir(target, signal), ctx.fs.processPath(target), settings.maxEntries)
  } catch (error) {
    // A session that received no files has no uploads directory, and a provider
    // that cannot reach the session filesystem at all is already reported by
    // whichever file operation the model attempts next. Neither may fail a turn
    // that would otherwise answer without this inventory.
    if (error instanceof FsError) {
      ctx.logger.debug(`session-uploads: no inventory (${error.code}): ${error.message}`)
      return ''
    }
    throw error
  }
}

/** Reject a directory name the filesystem lookup cannot honor. The schema has already bounded `maxEntries`. */
function assertRelative(directory: string): void {
  const segments = directory.split(/[/\\]/)
  if (directory.length === 0 || directory.startsWith('/')
    || directory.startsWith('\\') || segments.includes('..')) {
    throw new Error(`session-uploads: directory must be a relative path inside the session directory, got ${JSON.stringify(directory)}`)
  }
}
