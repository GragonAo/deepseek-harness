/**
 * Model-facing deliverable declaration: `present` records the files one turn hands to the user as
 * a durable `deliverables/presented` event, and the `deliverables` projection folds those events
 * into the per-turn list a client renders.
 *
 * The delivered list is the declaration itself, never the set of paths a turn touched and never a
 * reading of the closing prose: a draft, an extracted intermediate, or a helper script stays out
 * unless the model presents it, so what a user sees under a turn is what that turn decided to hand
 * over. The declaration is also validated where it is made — the composed filesystem must resolve
 * every path to a regular file that exists — so a turn cannot advertise a file it never wrote.
 *
 * @module @deepseek-ai/dsh-tool-present
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections and ctx.systemPrompt for the registrations below.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { DeliverablesState, PresentedFile } from './types.ts'
// The `deliverables` projection-key declaration and the event declaration live in src/types.ts
// (their one home); this re-export keeps the module edge in the emitted index.d.ts so aggregate
// programs consuming the declarations still receive the merges.
export type * from './types.ts'

export const name = 'tool-present'
export const inject = ['tools', 'systemPrompt']

/** Model-facing deliverable declaration configuration. */
export interface Config {
  /**
   * How many of the most recent turns the projection retains. Older turns drop out of the state,
   * which bounds what a long session ships to a client on every delivery; the session log keeps
   * every declaration, so a client that reads history can still find them.
   */
  retainTurns: number
}

/** Schemastery configuration for the present tool. */
export const Config: z<Config> = z.object({
  retainTurns: z.number().default(50),
})

const GUIDANCE =
  'When a task produces files the user is meant to keep, call the present tool with exactly those '
  + 'files and one short description each. Present the finished deliverables only: never drafts, '
  + 'intermediate data, or helper scripts written along the way. A turn whose answer needs no file '
  + 'presents nothing, and presenting the same file twice in one turn changes nothing.'

/** One declared file after validation, in the path vocabulary the declaration records. */
interface ResolvedFile {
  path: string
  description?: string
}

/**
 * Read the turn that is running now.
 *
 * The turn boundary is the log's own: scanning back from the newest event, a `turn/start` means a
 * turn is open and a `turn/end` means none is. `present` outside a turn has nowhere to attribute
 * a declaration and is rejected at the call site.
 *
 * @param events - the session log to scan.
 * @returns the open turn number, or `undefined` when no turn is open.
 */
function openTurn(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') return undefined
    if (event.type === 'turn/start') return event.data.turn
  }
  return undefined
}

/**
 * Validate the model's entries and resolve every path through the composed filesystem.
 *
 * Resolution is the enforcement point for "declare a file that exists": the same backend the file
 * tools write through answers whether the path names a regular file, so a declaration cannot
 * advertise a file this turn never created. The recorded path is the backend's display path, the
 * absolute path in the execution world that a consumer translates into its own file vocabulary.
 *
 * @param fs - the composed filesystem, or `undefined` in a headless assembly without one.
 * @param exec - the tool execution supplying the session cwd and cancellation.
 * @param input - the model's raw entries.
 * @returns the validated files in declaration order.
 * @throws when an entry is malformed, repeats a path, or names something that is not an existing
 * regular file.
 */
async function resolveFiles(
  fs: FileSystem | undefined,
  exec: ToolExecution,
  input: readonly { path: string; description?: string }[],
): Promise<ResolvedFile[]> {
  const resolved: ResolvedFile[] = []
  const seen = new Set<string>()
  const cwd = exec.agent?.session.header.cwd
  for (const entry of input) {
    const path = entry.path.trim()
    if (path.length === 0) throw new Error('present: every entry needs a non-empty `path`')
    const rawDescription = entry.description
    const description = rawDescription === undefined ? undefined : rawDescription.trim()
    if (description !== undefined && description.length === 0) {
      throw new Error(`present: "${path}" carries an empty description; omit the field instead`)
    }
    let recorded = path
    if (fs !== undefined) {
      const target = await fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
      const info = await fs.stat(target, exec.signal)
      if (info === undefined) {
        throw new Error(`present: "${path}" does not exist — declare the files this task actually wrote`)
      }
      if (info.type !== 'file') throw new Error(`present: "${path}" is a ${info.type}, not a file`)
      recorded = target.displayPath
    }
    if (seen.has(recorded)) throw new Error(`present: "${recorded}" is declared twice`)
    seen.add(recorded)
    resolved.push(description === undefined ? { path: recorded } : { path: recorded, description })
  }
  if (resolved.length === 0) throw new Error('present: declare at least one file')
  return resolved
}

/**
 * Fold one declaration into the whole-value projection state: the declaring turn's entry gains the
 * new paths (first declaration wins, so re-presenting a file is a no-op), turns stay ordered, and
 * only the most recent `retainTurns` survive.
 *
 * @param state - the previous state; never mutated.
 * @param turn - the declaring turn.
 * @param files - the declared files.
 * @param retainTurns - how many turns to keep; `0` keeps none.
 * @returns the next state.
 */
function withPresentation(
  state: DeliverablesState,
  turn: number,
  files: readonly PresentedFile[],
  retainTurns: number,
): DeliverablesState {
  const merged = state.turns
    .filter(entry => entry.turn !== turn)
    .map(entry => ({ turn: entry.turn, files: [...entry.files] }))
  const target = state.turns.find(entry => entry.turn === turn)
  const kept = target === undefined ? [] : [...target.files]
  for (const file of files) {
    if (!kept.some(entry => entry.path === file.path)) kept.push(file)
  }
  merged.push({ turn, files: kept })
  merged.sort((left, right) => left.turn - right.turn)
  return { turns: retainTurns > 0 ? merged.slice(-retainTurns) : [] }
}

/** Wire payload schema of the `deliverables` projection. */
const presentedFileSchema = zod.object({
  path: zod.string(),
  description: zod.string().optional(),
})

const deliverablesSchema: ZodType<DeliverablesState> = zod.object({
  turns: zod.array(zod.object({
    turn: zod.number(),
    files: zod.array(presentedFileSchema),
  })),
})

/**
 * Register the `present` tool, its system-prompt guidance, and — when the session-projection seam
 * is composed — the `deliverables` unit.
 * @param ctx - registrant context carrying the tool registry and the prompt composer.
 * @param config - deployment's retention window.
 */
export function apply(ctx: Context, config: Config): void {
  const retainTurns = config.retainTurns
  // The unit child activates only when a projection registry is composed (headless assemblies
  // without the seam stay unaffected). Every event other than a declaration returns the same state
  // reference, which is what the registry's whole-value gate reads.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'deliverables', DeliverablesState>({
      key: 'deliverables',
      schema: deliverablesSchema,
      init: () => ({ turns: [] }),
      apply: (state, event) => event.type === 'deliverables/presented'
        ? withPresentation(state, event.data.turn, event.data.files, retainTurns)
        : state,
      view: state => state,
      stateVersion: 1,
    })
  })

  ctx.systemPrompt.section({ name: 'tool:present', order: 105, text: GUIDANCE })

  ctx.tools.register(defineTool({
    name: 'present',
    description: 'Declare the files this task delivers to the user. Call it once the deliverables of the task are written.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: 'The finished files this turn hands to the user, in the order they should be shown.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              required: true,
              description: 'A file this task wrote; a relative path resolves against the working directory.',
            },
            description: {
              type: 'string',
              description: 'One line telling the user what this file is.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          turn: { type: 'integer', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Presented ${value.files.length} file(s) for turn ${value.turn}:\n`
          + value.files
            .map(file => file.description === undefined ? `- ${file.path}` : `- ${file.path} — ${file.description}`)
            .join('\n'),
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) {
        // The declaration is per-turn session state; a non-agent caller has no turn to attribute
        // it to, so it is rejected rather than silently dropped.
        throw new Error('present requires an owning agent session')
      }
      const files = await resolveFiles(ctx.get('fs'), exec, args.files)
      const turn = openTurn(session.events)
      if (turn === undefined) throw new Error('present must be called while a turn is running')
      session.append('deliverables/presented', { turn, callId: exec.callId, files })
      return { turn, files }
    },
    presentCall: args => ({ card: 'generic', title: 'Present deliverables', kind: 'other', rawInput: args.files }),
  }))
}
