/**
 * Mounted plugins through path specifiers: a `./`-relative row in a real
 * composition resolves beside its configuration file, mounts code the
 * deployment owns, and registers that plugin's tools.
 *
 * This is the mechanism a deployment uses to add business integration without
 * an image rebuild, and the resolution is the Loader's own — `baseUrl` is the
 * configuration file's directory, so the row stays relative and the plugin
 * moves with the config rather than with the process working directory.
 *
 * An absolute-path row is the CLI's own concern: `mountRootInclude` only
 * converts one to a file URL when the launcher supplies a bare-module base,
 * which this composition does not.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { boot } from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-mounted-'))

/**
 * A mounted plugin that registers a tool and announces itself.
 * @param tool - the tool name it registers, so two mounted plugins can coexist.
 * @returns the plugin's source.
 */
function probe(tool: string): string {
  return [
    'export const name = "mounted-probe"',
    'export const inject = ["tools"]',
    'export function apply(ctx) {',
    '  const dispose = ctx.tools.register({',
    '    name: ' + JSON.stringify(tool) + ',',
    '    description: "Registered from a mounted plugin directory.",',
    '    parameters: {},',
    '    execute: () => ({ ok: true }),',
    '    output: {',
    '      schema: {',
    '        type: "object",',
    '        additionalProperties: false,',
    '        properties: { ok: { type: "boolean" } },',
    '      },',
    '      render: () => [{ type: "text", text: "mounted" }],',
    '    },',
    '  })',
    '  ctx.provide(' + JSON.stringify('mounted_' + tool) + ', { dispose })',
    '}',
    '',
  ].join('\n')
}

/** Write `files` under a fresh directory, keyed by relative path. */
function dirWith(files: Readonly<Record<string, string>>): string {
  const dir = tmp()
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

/** The row a deployment writes per mounted plugin, naming `relative` in `dir`. */
function row(relative: string): string {
  return '- id: mounted\n  name: ' + JSON.stringify(relative)
}

/**
 * Boot a composition whose root config is the given rows, beside the plugin.
 * @param dir - directory holding `cordis.yml` and the mounted plugin.
 * @param rows - the root config's entry rows.
 * @returns the settled root context.
 */
function bootRows(dir: string, rows: readonly string[]) {
  const config = join(dir, 'cordis.yml')
  writeFileSync(config, [...rows, ''].join('\n'))
  return boot(NAME, config, undefined, async (hostCtx) => {
    await hostCtx.plugin(SystemPrompt)
    await hostCtx.plugin(ToolRuntime)
  })
}

/**
 * Every message in a rejection's cause chain, so a boot failure that wraps its
 * cause stays assertable without matching the wrapper's wording.
 * @param error - the rejection value.
 * @returns the messages, outermost first, one per line.
 */
function messagesOf(error: unknown): string {
  const messages: string[] = []
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    messages.push(current.message)
    if (current instanceof AggregateError) {
      for (const inner of current.errors as readonly unknown[]) messages.push(messagesOf(inner))
    }
  }
  return messages.join('\n')
}

describe('mounted plugins by path specifier', () => {
  it('mounts a plugin from a relative row and it registers its tool', async () => {
    const dir = dirWith({ 'probe.mjs': probe('probe_tool') })
    const ctx = await bootRows(dir, [row('./probe.mjs')])
    try {
      expect(ctx.get('mounted_probe_tool')).toBeDefined()
      expect(ctx.get('tools')?.get('probe_tool')?.description)
        .toBe('Registered from a mounted plugin directory.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves the row beside the configuration file, not the process cwd', async () => {
    const dir = dirWith({ 'plugins/probe/index.mjs': probe('probe_tool') })
    const ctx = await bootRows(dir, [row('./plugins/probe/index.mjs')])
    try {
      expect(ctx.get('tools')?.get('probe_tool')).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('mounts two mounted plugins in one composition', async () => {
    const dir = dirWith({ 'a.mjs': probe('probe_tool'), 'b.mjs': probe('second_tool') })
    const ctx = await bootRows(dir, [
      '- id: first\n  name: ' + JSON.stringify('./a.mjs'),
      '- id: second\n  name: ' + JSON.stringify('./b.mjs'),
    ])
    try {
      expect(ctx.get('tools')?.get('probe_tool')).toBeDefined()
      expect(ctx.get('tools')?.get('second_tool')).toBeDefined()
      const mounted = [...ctx.loader.entries()]
        .filter(entry => entry.options.name === './a.mjs' || entry.options.name === './b.mjs')
      expect(mounted).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loud when the row names a directory rather than its entry file', async () => {
    // The mistake a deployment makes once: ESM resolves no directory index,
    // so the row must name the entry file itself.
    const dir = dirWith({ 'plugins/probe/index.mjs': probe('probe_tool') })
    const failure = await bootRows(dir, [row('./plugins/probe')]).catch((error: unknown) => error)
    expect(messagesOf(failure)).toContain('plugins/probe')
  })

  it('fails loud when the relative row names no file, naming the path', async () => {
    const dir = dirWith({})
    const failure = await bootRows(dir, [row('./absent.mjs')]).catch((error: unknown) => error)
    expect(messagesOf(failure)).toContain('absent.mjs')
  })

  it('disposal removes the mounted plugin tool', async () => {
    const dir = dirWith({ 'probe.mjs': probe('probe_tool') })
    const ctx = await bootRows(dir, [row('./probe.mjs')])
    expect(ctx.get('tools')?.get('probe_tool')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('tools')?.get('probe_tool')).toBeUndefined()
  })
})
