import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContainerCommandResult } from '@deepseek-ai/dsh-container'
import { ContainerFileSystem } from '../src/index.ts'

interface Entry { type: 'file' | 'directory'; content?: string }

interface Call { script: string; opts?: { stdin?: string } }

function mount() {
  const store = new Map<string, Entry>([
    ['/workspace', { type: 'directory' }],
    ['/workspace/a.txt', { type: 'file', content: 'hello\n' }],
    ['/workspace/sub', { type: 'directory' }],
    ['/workspace/sub/b.txt', { type: 'file', content: 'world' }],
  ])
  const calls: Call[] = []
  const containerRuntime = {
    exec: async (_command: string, args: readonly string[], opts?: { stdin?: string }): Promise<ContainerCommandResult> => {
      const script = args.length >= 2 && args[0] === '-c' ? String(args[1]) : ''
      calls.push(opts === undefined ? { script } : { script, opts })
      const path = script.match(/'([^']*)'$/)?.[1] ?? ''
      if (script.startsWith('stat ')) {
        const entry = store.get(path)
        if (entry === undefined) return { exitCode: 1, stdout: '', stderr: 'stat: cannot stat: No such file or directory' }
        const rawKind = entry.type === 'directory' ? 'directory' : (entry.content ?? '') === '' ? 'regular empty file' : 'regular file'
        const size = entry.type === 'file' ? Buffer.byteLength(entry.content ?? '') : 0
        return { exitCode: 0, stdout: `${rawKind}|${size}|1700000000`, stderr: '' }
      }
      if (script.startsWith('cat > ')) {
        store.set(path, { type: 'file', content: opts?.stdin ?? '' })
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (script.startsWith('cat ')) {
        const entry = store.get(path)
        if (entry === undefined) return { exitCode: 1, stdout: '', stderr: `cat: ${path}: No such file or directory` }
        if (entry.type === 'directory') return { exitCode: 1, stdout: '', stderr: `cat: ${path}: Is a directory` }
        return { exitCode: 0, stdout: entry.content ?? '', stderr: '' }
      }
      if (script.startsWith('base64 < ')) {
        const entry = store.get(path)
        if (entry === undefined) return { exitCode: 1, stdout: '', stderr: 'No such file or directory' }
        return { exitCode: 0, stdout: Buffer.from(entry.content ?? '').toString('base64'), stderr: '' }
      }
      if (script.startsWith('find ')) {
        const dir = script.match(/'([^']*)'/)?.[1] ?? ''
        const lines: string[] = []
        for (const [key, entry] of store) {
          if (key.startsWith(`${dir}/`) && !key.slice(dir.length + 1).includes('/')) {
            const name = key.split('/').at(-1) ?? ''
            const kind = entry.type === 'directory' ? 'd' : 'f'
            const size = entry.type === 'file' ? Buffer.byteLength(entry.content ?? '') : 0
            lines.push(`${name}\t${kind}\t${size}`)
          }
        }
        return { exitCode: 0, stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  const ctx = new Context()
  ctx.provide('containerRuntime', containerRuntime)
  return { fs: new ContainerFileSystem(ctx, { root: '/workspace' }), calls, store }
}

describe('ContainerFileSystem', () => {
  it('resolves paths, exposes the container process path, and contains children', async () => {
    const { fs } = mount()
    const target = await fs.resolve('sub/b.txt')
    expect(target.displayPath).toBe('/workspace/sub/b.txt')
    expect(fs.processPath(target)).toBe('/workspace/sub/b.txt')
    expect(fs.fileUrl(target)).toBe('file:///workspace/sub/b.txt')
    const parent = await fs.resolve('/workspace/sub')
    expect(fs.contains(parent, target)).toBe(true)
    expect(fs.contains(target, parent)).toBe(false)
  })

  it('reads text and rejects absent targets', async () => {
    const { fs } = mount()
    const target = await fs.resolve('a.txt')
    await expect(fs.readText(target)).resolves.toBe('hello\n')
    const missing = await fs.resolve('/workspace/nope.txt')
    await expect(fs.readText(missing)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('reports binary files as non-text', async () => {
    const raw = Buffer.from([0x01, 0x02, 0x00])
    const containerRuntime = {
      exec: async (): Promise<ContainerCommandResult> => ({ exitCode: 0, stdout: raw.toString('latin1'), stderr: '' }),
    }
    const ctx = new Context()
    ctx.provide('containerRuntime', containerRuntime)
    const fs = new ContainerFileSystem(ctx, { root: '/workspace' })
    const target = await fs.resolve('bin')
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('lists direct children in stable order', async () => {
    const { fs } = mount()
    const target = await fs.resolve('/workspace')
    const entries = await fs.listDir(target)
    expect(entries.map(entry => entry.name)).toEqual(['a.txt', 'sub'])
    expect(entries[0]?.type).toBe('file')
    expect(entries[1]?.type).toBe('directory')
  })

  it('writes create/update atomically and guards create-if-absent', async () => {
    const { fs } = mount()
    const target = await fs.resolve('new.txt')
    const created = await fs.writeText(target, 'x\n')
    expect(created.operation).toBe('create')
    expect(created.before).toBeNull()
    expect(created.after).toBe('x\n')
    const updated = await fs.writeText(target, 'y\n')
    expect(updated.operation).toBe('update')
    expect(updated.before).toBe('x\n')
    await expect(fs.writeText(target, 'z\n', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('edits literal text and reports absent/ambiguous matches', async () => {
    const { fs } = mount()
    const target = await fs.resolve('a.txt')
    const outcome = await fs.editText(target, { oldString: 'hello', newString: 'hi', replaceAll: false })
    expect(outcome.after).toBe('hi\n')
    await expect(fs.editText(target, { oldString: 'missing', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await fs.writeText(target, 'same\nsame\n')
    await expect(fs.editText(target, { oldString: 'same', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
  })
})
