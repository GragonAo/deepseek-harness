/**
 * The mounted plugin root resolver: reference validation, entry discovery, and
 * the loud failures an operator sees for a mistyped deployment path.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as PluginRoots from '../src/index.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-plugin-roots-'))

/** A directory holding `files`, keyed by relative path. */
function dirWith(files: Readonly<Record<string, string>>): string {
  const dir = tmp()
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

describe('createPluginRoots', () => {
  it('loads nothing by default: an empty root list refuses every reference', () => {
    const roots = PluginRoots.createPluginRoots([])
    expect(roots.roots).toEqual([])
    expect(() => roots.resolve('anything')).toThrow(/no configured root provides "anything"; searched $/u)
  })

  it('fails loud on a configured root that does not exist, naming the path', () => {
    const missing = join(tmp(), 'absent')
    expect(() => PluginRoots.createPluginRoots([missing])).toThrow(
      `plugin-roots: configured root ${JSON.stringify(missing)} does not exist (resolved to ${missing})`,
    )
  })

  it('fails loud when a configured root is a file rather than a directory', () => {
    const dir = dirWith({ 'not-a-dir': '' })
    const file = join(dir, 'not-a-dir')
    expect(() => PluginRoots.createPluginRoots([file])).toThrow(/is not a directory/u)
  })

  it('resolves an index file inside the reference directory', () => {
    const root = dirWith({ 'probe/index.mjs': 'export const name = "probe"\n' })
    expect(PluginRoots.createPluginRoots([root]).resolve('probe')).toBe(join(root, 'probe', 'index.mjs'))
  })

  it('prefers the entry a package manifest declares, in exports then main', () => {
    const exported = dirWith({
      'probe/package.json': JSON.stringify({ exports: { '.': { import: './entry.mjs' } } }),
      'probe/entry.mjs': '',
    })
    expect(PluginRoots.createPluginRoots([exported]).resolve('probe')).toBe(join(exported, 'probe', 'entry.mjs'))

    const main = dirWith({ 'probe/package.json': JSON.stringify({ main: './lib/start.js' }), 'probe/lib/start.js': '' })
    expect(PluginRoots.createPluginRoots([main]).resolve('probe')).toBe(join(main, 'probe', 'lib', 'start.js'))
  })

  it('fails loud when a manifest declares an entry that does not exist', () => {
    const root = dirWith({ 'probe/package.json': JSON.stringify({ exports: './missing.mjs' }) })
    expect(() => PluginRoots.createPluginRoots([root]).resolve('probe')).toThrow(
      /declares entry "\.\/missing\.mjs", which does not exist$/u,
    )
  })

  it('fails loud on a manifest that is not JSON', () => {
    const root = dirWith({ 'probe/package.json': '{ not json' })
    expect(() => PluginRoots.createPluginRoots([root]).resolve('probe')).toThrow(/is not valid JSON/u)
  })

  it('searches roots in order and reports every directory it searched on a miss', () => {
    const first = dirWith({ 'other/index.mjs': '' })
    const second = dirWith({ 'probe/index.mjs': '' })
    const roots = PluginRoots.createPluginRoots([first, second])
    expect(roots.resolve('probe')).toBe(join(second, 'probe', 'index.mjs'))
    expect(() => roots.resolve('absent')).toThrow(
      `plugin-roots: no configured root provides "absent"; searched ${join(first, 'absent')}, ${join(second, 'absent')}`,
    )
  })

  it('refuses a reference that is absolute or escapes its root', () => {
    const roots = PluginRoots.createPluginRoots([dirWith({})])
    expect(() => roots.resolve('')).toThrow(/needs a name after the prefix/u)
    expect(() => roots.resolve(resolve('/', 'elsewhere'))).toThrow(/is absolute/u)
    expect(() => roots.resolve('../elsewhere')).toThrow(/escapes its root/u)
  })

  it('publishes the resolver as the pluginRoots service', async () => {
    const root = dirWith({ 'probe/index.mjs': '' })
    const ctx = new Context()
    try {
      await ctx.plugin(PluginRoots, { roots: [root] })
      expect(ctx.get('pluginRoots')?.roots).toEqual([root])
      expect(ctx.get('pluginRoots')?.resolve('probe')).toBe(join(root, 'probe', 'index.mjs'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects the whole mount when a configured root is missing, publishing nothing', async () => {
    const ctx = new Context()
    try {
      await expect(ctx.plugin(PluginRoots, { roots: [join(tmp(), 'absent')] })).rejects.toThrow(/does not exist/u)
      expect(ctx.get('pluginRoots')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
