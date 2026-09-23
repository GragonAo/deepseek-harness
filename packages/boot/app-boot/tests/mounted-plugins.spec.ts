/**
 * Mounted plugin roots end to end: a `local:` row in a real composition
 * resolves to code the deployment mounted, registers its tools, and every
 * misconfiguration stops the boot with the path that caused it.
 *
 * The roots service is mounted by the host preparation step rather than by a
 * `plugin-roots` row, because a row names the package and the source plane has
 * no built `lib/` to resolve. The row form reaches the same `apply`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PluginRoots from '../../plugin-roots/src/index.ts'
import { boot } from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-mounted-'))

/** A mounted plugin that registers a tool and announces itself. */
const PROBE = [
  'export const name = "mounted-probe"',
  'export const inject = ["tools"]',
  'export function apply(ctx) {',
  '  const dispose = ctx.tools.register({',
  '    name: "probe_tool",',
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
  '  ctx.provide("mountedProbe", { dispose })',
  '}',
  '',
].join('\n')

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

/**
 * Boot a composition whose root config is the given rows, with a real tool
 * registry on the host and the deployment's roots in place.
 * @param rows - the root config's entry rows.
 * @param roots - the mounted plugin roots; omitted mounts none.
 * @returns the settled root context.
 */
function bootRows(rows: readonly string[], roots?: readonly string[]) {
  const dir = tmp()
  writeFileSync(join(dir, 'cordis.yml'), rows.length === 0 ? '[]\n' : [...rows, ''].join('\n'))
  return boot(NAME, join(dir, 'cordis.yml'), undefined, async (hostCtx) => {
    await hostCtx.plugin(SystemPrompt)
    await hostCtx.plugin(ToolRuntime)
    if (roots !== undefined) await hostCtx.plugin(PluginRoots, { roots: [...roots] })
  })
}

/** The one row a deployment writes per mounted plugin. */
function mountedRow(reference: string): string[] {
  return ['- id: mounted', `  name: 'local:${reference}'`]
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

describe('mounted plugin roots', () => {
  it('loads a plugin from a configured root and it registers its tool', async () => {
    const root = dirWith({ 'probe/index.mjs': PROBE })
    const ctx = await bootRows(mountedRow('probe'), [root])
    try {
      expect(ctx.get('mountedProbe')).toBeDefined()
      expect(ctx.get('tools')?.get('probe_tool')?.description)
        .toBe('Registered from a mounted plugin directory.')
      expect([...ctx.loader.entries()].some(entry => entry.options.name === 'local:probe')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves a reference through the entry its package manifest declares', async () => {
    const root = dirWith({
      'probe/package.json': JSON.stringify({ name: 'dsh-plugin-probe', type: 'module', exports: './lib/probe.mjs' }),
      'probe/lib/probe.mjs': PROBE,
    })
    const ctx = await bootRows(mountedRow('probe'), [root])
    try {
      expect(ctx.get('tools')?.get('probe_tool')).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reaches a mounted directory whose name matches an installed package', async () => {
    const root = dirWith({
      '@deepseek-ai/dsh-tools/index.mjs': [
        'export const name = "shadow"',
        'export function apply(ctx) {',
        '  ctx.provide("mountedProbe", { shadowed: true })',
        '}',
        '',
      ].join('\n'),
    })
    const ctx = await bootRows(mountedRow('@deepseek-ai/dsh-tools'), [root])
    try {
      // The prefix decides: a mounted reference never competes with npm resolution.
      expect(ctx.get('mountedProbe')).toEqual({ shadowed: true })
      expect(ctx.get('tools')?.get('probe_tool')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails loud when a local: row has no plugin root above it', async () => {
    await expect(bootRows(mountedRow('probe'))).rejects.toThrow(
      'local:probe: no plugin root is configured. Add a @deepseek-ai/dsh-plugin-roots row carrying `roots:` above this entry.',
    )
  })

  it('fails loud when a configured root does not exist, naming the path', async () => {
    const missing = join(tmp(), 'absent')
    const failure = await bootRows(mountedRow('probe'), [missing]).catch((error: unknown) => error)
    expect(messagesOf(failure)).toContain(
      `plugin-roots: configured root ${JSON.stringify(missing)} does not exist (resolved to ${missing})`,
    )
  })

  it('fails loud when no root provides the reference, naming every directory searched', async () => {
    const root = dirWith({})
    const failure = await bootRows(mountedRow('probe'), [root]).catch((error: unknown) => error)
    expect(messagesOf(failure)).toContain(
      `plugin-roots: no configured root provides "probe"; searched ${join(root, 'probe')}`,
    )
  })

  it('loads nothing from disk when no root is configured', async () => {
    const ctx = await bootRows([])
    try {
      expect(ctx.get('pluginRoots')).toBeUndefined()
      expect(ctx.get('mountedProbe')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
