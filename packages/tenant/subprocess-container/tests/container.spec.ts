import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContainerCommandResult } from '@deepseek-ai/dsh-container'
import { composeDshEnvironment } from '@deepseek-ai/dsh-shell-env'
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

/**
 * A runtime whose write-effect scan answers with `produced`, so the scan itself
 * is observable without a real container.
 */
function mountScanning(answers: {
  markExitCode?: number
  markRejects?: boolean
  scan?: Partial<ContainerCommandResult>
  scanRejects?: boolean
  commandRejects?: boolean
}) {
  const calls: Call[] = []
  const containerRuntime = {
    exec: async (command: string, args: readonly string[], opts?: Call['opts']): Promise<ContainerCommandResult> => {
      calls.push(opts === undefined ? { command, args } : { command, args, opts })
      if (command === 'touch') {
        if (answers.markRejects === true) throw new Error('container unreachable')
        return { exitCode: answers.markExitCode ?? 0, stdout: '', stderr: '' }
      }
      if (command === 'sh') {
        if (answers.scanRejects === true) throw new Error('container unreachable')
        return { exitCode: 0, stdout: '', stderr: '', ...answers.scan }
      }
      if (answers.commandRejects === true) throw new Error('container vanished')
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

/** A spawn carrying the session identity that makes write-effect observation applicable. */
function sessionSpec(argv: readonly string[]): SubprocessSpawnSpec {
  return {
    ...collectSpec(argv),
    env: composeDshEnvironment({ dshHome: '/root/.dsh', sessionId: 'session-tenant-7' }),
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

  it('forwards the caller-composed managed DSH_* group unchanged', async () => {
    const { runtime, calls } = mount()
    // The group is assembled by its sole owner (`ctx.shellEnv`); this provider
    // is a carrier, so the bash entry point's container process receives
    // exactly what the owner composed — no subset, no rewrite.
    const managed = composeDshEnvironment({ dshHome: '/root/.dsh', sessionId: 'session-tenant-7' })
    const handle = runtime.spawn({ ...collectSpec(['echo', 'hi']), env: managed })
    await handle.done

    const env = calls.find(c => c.command === 'echo')?.opts?.env
    expect(env).toEqual(managed)
    expect(env?.DSH_SESSION_ID).toBe('session-tenant-7')
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

describe('ContainerSubprocessRuntime write-effect observation', () => {
  it('reports the files a session command created or modified', async () => {
    const { runtime, calls } = mountScanning({
      scan: { stdout: '/sessions/session-tenant-7/out/report.docx\n/sessions/session-tenant-7/out/notes.md\n' },
    })
    const outcome = await runtime.spawn(sessionSpec(['python', 'make.py'])).done

    expect(outcome).toEqual({
      exitCode: 0,
      signal: null,
      produced: ['/sessions/session-tenant-7/out/report.docx', '/sessions/session-tenant-7/out/notes.md'],
    })
    // The two observations run in order around the command: a marker created
    // before it, then one scan that compares the session directory against it.
    expect(calls.map(call => call.command)).toEqual(['touch', 'python', 'sh'])
    const scan = calls[2]?.args[1] ?? ''
    expect(scan).toContain('find \'/sessions/session-tenant-7\' -type f -newer')
    expect(scan).toContain('-printf')
    expect(scan).toContain('rm -f ')
  })

  it('reports nothing rather than failing when the scan cannot answer', async () => {
    const { runtime } = mountScanning({ scanRejects: true })
    await expect(runtime.spawn(sessionSpec(['python', 'make.py'])).done)
      .resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('reports nothing when the marker itself could not be created', async () => {
    const { runtime, calls } = mountScanning({ markExitCode: 1, scan: { stdout: '/sessions/session-tenant-7/stale\n' } })
    await expect(runtime.spawn(sessionSpec(['python', 'make.py'])).done)
      .resolves.toEqual({ exitCode: 0, signal: null })
    // Without a marker there is nothing to compare against, so no scan runs.
    expect(calls.map(call => call.command)).toEqual(['touch', 'python'])
  })

  it('reports nothing when the marker probe could not reach the container', async () => {
    const { runtime } = mountScanning({ markRejects: true })
    await expect(runtime.spawn(sessionSpec(['python', 'make.py'])).done)
      .resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('reports nothing when the scan itself exits nonzero', async () => {
    const { runtime } = mountScanning({ scan: { exitCode: 1, stdout: '/sessions/session-tenant-7/partial\n' } })
    // A partial list from an incomplete scan reads as a complete one, so a
    // nonzero scan exit reports no files at all.
    await expect(runtime.spawn(sessionSpec(['python', 'make.py'])).done)
      .resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('reports nothing when the command wrote no file', async () => {
    const { runtime } = mountScanning({ scan: { stdout: '\n' } })
    await expect(runtime.spawn(sessionSpec(['true'])).done)
      .resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('keeps the run failure when the command exec rejects, scanning only to clean up', async () => {
    const { runtime, calls } = mountScanning({ commandRejects: true })
    await expect(runtime.spawn(sessionSpec(['python', 'make.py'])).done)
      .rejects.toThrow('container vanished')
    expect(calls.map(call => call.command)).toEqual(['touch', 'python', 'sh'])
  })

  it('drops the partial first line of a capped scan', async () => {
    const { runtime } = mountScanning({
      scan: {
        stdout: 'artial/path.docx\n/sessions/session-tenant-7/out/report.docx\n',
        stdoutTruncated: true,
      },
    })
    const outcome = await runtime.spawn(sessionSpec(['python', 'make.py'])).done
    expect(outcome.produced).toEqual(['/sessions/session-tenant-7/out/report.docx'])
  })

  it('reports nothing for a command without a session identity', async () => {
    const { runtime, calls } = mount()
    await runtime.spawn(collectSpec(['echo', 'hi'])).done
    // No session directory to attribute writes to, so no observation exec runs.
    expect(calls.map(call => call.command)).toEqual(['echo'])
  })
})
