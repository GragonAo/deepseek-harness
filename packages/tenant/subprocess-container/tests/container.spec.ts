import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContainerCommandResult } from '@deepseek-ai/dsh-container'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ContainerSubprocessRuntime } from '../src/index.ts'

interface Call {
  command: string
  args: readonly string[]
  opts?: { stdin?: string; cwd?: string; env?: Readonly<Record<string, string>> }
}

function mount() {
  const calls: Call[] = []
  const containerRuntime = {
    exec: async (command: string, args: readonly string[], opts?: Call['opts']): Promise<ContainerCommandResult> => {
      calls.push(opts === undefined ? { command, args } : { command, args, opts })
      const script = args.length >= 2 && args[0] === '-c' ? String(args[1]) : ''
      if (script.includes('command -v')) return { exitCode: 0, stdout: '/usr/bin/echo\n', stderr: '' }
      if (script.includes('test -x')) return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: 'hello\n', stderr: '' }
    },
  }
  const ctx = new Context()
  ctx.provide('containerRuntime', containerRuntime)
  return { runtime: new ContainerSubprocessRuntime(ctx), calls }
}

function collectSpec(argv: readonly string[]): SubprocessSpawnSpec {
  return {
    argv,
    cwd: '/workspace',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'inherit' },
    graceMs: 1000,
  }
}

describe('ContainerSubprocessRuntime', () => {
  it('resolves an absolute executable inside the container', async () => {
    const { runtime, calls } = mount()
    await expect(runtime.resolveExecutable('/usr/bin/echo')).resolves.toBe('/usr/bin/echo')
    // The probe must stay dash-compatible: the tool-exec container's /bin/sh is
    // dash, whose `test` rejects the bash-only `--` end-of-options marker.
    expect(calls.some(c => c.args[1] === "test -x '/usr/bin/echo'")).toBe(true)
    expect(calls.some(c => c.args[1]?.includes('test -x --'))).toBe(false)
  })

  it('resolves a bare name via the container PATH', async () => {
    const { runtime } = mount()
    await expect(runtime.resolveExecutable('echo')).resolves.toBe('/usr/bin/echo')
  })

  it('runs a spawn inside the container and serves captured stdout', async () => {
    const { runtime, calls } = mount()
    const handle = runtime.spawn(collectSpec(['echo', 'hi']))
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0)).toMatchObject({ text: 'hello\n', lossy: false })
    const exec = calls.find(c => c.command === 'echo')
    expect(exec?.args).toEqual(['hi'])
    expect(exec?.opts?.cwd).toBe('/workspace')
  })

  it('rejects piped stdio in the slice', () => {
    const { runtime } = mount()
    const spec = collectSpec(['echo'])
    spec.stdio.stdout = 'pipe'
    expect(() => runtime.spawn(spec)).toThrow(/piped stdio/)
  })

  it('rejects terminal allocation in the slice', async () => {
    const { runtime } = mount()
    await expect(runtime.spawnTerminal({
      argv: ['sh'],
      cwd: '/workspace',
      rows: 24,
      cols: 80,
      graceMs: 1000,
    })).rejects.toThrow(/spawnTerminal/)
  })
})
