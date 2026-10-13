import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type {
  ContainerCommandResult,
  ContainerExecOptions,
  ContainerPtyOptions,
  ContainerPtySession,
} from '@deepseek-ai/dsh-container'
import { ContainerCodeRuntime } from '@deepseek-ai/dsh-code-runtime-container'
import type { Config } from '@deepseek-ai/dsh-code-runtime-container'
import type { CodeBindingFunction, CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime'
import { composeDshEnvironment } from '@deepseek-ai/dsh-shell-env'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

/**
 * Integration suite over a REAL in-process host bridge plus a LOCAL exec
 * stand-in for the tenant container: it runs the same self-contained
 * bootstrap with `node -e` (on the host loopback, which the suite points
 * `hostBridge` at) so the full transport — argue binding call, bridge HTTP
 * round-trip, frame emission, host parse — runs end to end without Docker.
 */
class LocalExecRuntime extends ContainerRuntime {
  /** The exec environment of every call, in order: what the process starts from. */
  readonly environments: (Readonly<Record<string, string>> | undefined)[] = []

  async exec(command: string, args: readonly string[], opts?: ContainerExecOptions): Promise<ContainerCommandResult> {
    this.environments.push(opts?.env)
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...opts?.env },
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.once('error', reject)
      const onAbort = (): void => { child.kill('SIGKILL') }
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      child.once('close', (code) => {
        opts?.signal?.removeEventListener('abort', onAbort)
        resolve({
          exitCode: code ?? 0,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      })
      if (opts?.stdin !== undefined) child.stdin.write(opts.stdin)
      child.stdin.end()
    })
  }

  async openPty(_options: ContainerPtyOptions): Promise<ContainerPtySession> {
    throw new Error('LocalExecRuntime: no interactive session')
  }
}

async function setup(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalExecRuntime, undefined)
  await ctx.plugin(ContainerCodeRuntime, { hostBridge: '127.0.0.1', ...config })
  return { ctx, runtime: ctx.codeRuntime as ContainerCodeRuntime }
}

/** Setup with the real owner of the managed `DSH_*` group mounted beside the runtime. */
async function setupManaging(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalExecRuntime, undefined)
  await ctx.plugin(BashEnvPlugin, { dshHome: './test-dsh-home' })
  await ctx.plugin(ContainerCodeRuntime, { hostBridge: '127.0.0.1', ...config })
  return { ctx, runtime: ctx.codeRuntime as ContainerCodeRuntime, exec: ctx.containerRuntime as LocalExecRuntime }
}

/** The `DSH_*` entries of one recorded exec environment. */
function dshEntries(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key.startsWith('DSH_')))
}

function tools(functions: Record<string, (args: unknown) => Promise<unknown>>): CodeBindingNamespace[] {
  return [{
    global: 'tools',
    functions: functions as Record<string, CodeBindingFunction>,
    errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
  }]
}

describe('ContainerCodeRuntime — programs and bindings over the bridge', () => {
  it('registers with the seam descriptors', async () => {
    const { runtime } = await setup()
    expect(runtime.language).toBe('typescript')
    expect(runtime.isolation).toBe('container')
  })

  it('runs TypeScript (erasable syntax), captures output in order, returns the value', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: [
        'interface Point { x: number; y: number }',
        'const p: Point = { x: 1, y: 2 } as Point;',
        "console.log('point', p);",
        "process.stdout.write('raw-out\\n');",
        "console.warn('careful');",
        'return p.x + p.y;',
      ].join('\n'),
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(3)
    expect(result.logs).toEqual(['point { x: 1, y: 2 }', 'raw-out\n', 'careful'])
  })

  it('bridges binding calls both ways and rejects a throwing host binding as a typed error', async () => {
    const { runtime } = await setup()
    const calls: unknown[] = []
    const result = await runtime.run({
      program: [
        'const first = await tools.echo({ n: 1 });',
        'let caught = {};',
        'try { await tools.fail({}) } catch (error) { caught = { isTyped: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message } }',
        'return { first, caught };',
      ].join('\n'),
      bindings: tools({
        echo: async (args) => { calls.push(args); return { echoed: args } },
        fail: async () => { throw new Error('nope') },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({
      first: { echoed: { n: 1 } },
      caught: { isTyped: true, name: 'ToolCallError', toolName: 'fail', message: 'nope' },
    })
    expect(calls).toEqual([{ n: 1 }])
  })

  it('rejects a call to an undeclared binding name as a program-side TypeError', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: 'try { await tools.missing({}) } catch (error) { return error.message }',
      bindings: tools({}),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('tools.missing is not a function')
  })

  it('reports a thrown program as kind exception', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({
      program: "throw new Error('boom')",
      bindings: [],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('boom')
  })

  it('reports a non-JSON completion as kind invalid-output', async () => {
    const { runtime } = await setup()
    const result = await runtime.run({ program: 'return function () {}', bindings: [] })
    expect(result.error?.kind).toBe('invalid-output')
  })

  it('maps a non-zero container exit without a frame to worker-exit', async () => {
    const ctx = new Context()
    // A stand-in whose exec always fails, exercising the host-side mapping.
    class BrokenRuntime extends ContainerRuntime {
      async exec(): Promise<ContainerCommandResult> {
        return { exitCode: 1, stdout: '', stderr: 'segfault' }
      }

      async openPty(_options: ContainerPtyOptions): Promise<ContainerPtySession> {
        throw new Error('BrokenRuntime: no interactive session')
      }
    }
    await ctx.plugin(BrokenRuntime, undefined)
    await ctx.plugin(ContainerCodeRuntime, { hostBridge: '127.0.0.1' })
    const runtime = ctx.codeRuntime as ContainerCodeRuntime
    const result = await runtime.run({ program: "console.log('hi')", bindings: [] })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('segfault')
  })
})

describe('ContainerCodeRuntime — the managed DSH_* group', () => {
  it('injects exactly the group its sole owner composes, and the program reads it', async () => {
    const { runtime, exec } = await setupManaging()
    const result = await runtime.run({ program: 'return process.env.DSH_HOME', bindings: [] })

    expect(result.value).toBe(resolve('./test-dsh-home'))
    expect(dshEntries(exec.environments[0])).toEqual({
      ...composeDshEnvironment({ dshHome: resolve('./test-dsh-home') }),
      DSH_CODE_BRIDGE: expect.any(String),
    })
  })

  it('injects no managed variable of its own without the shell-env registry', async () => {
    const { ctx, runtime } = await setup()
    await runtime.run({ program: 'return 1', bindings: [] })

    expect(dshEntries((ctx.containerRuntime as LocalExecRuntime).environments[0]))
      .toEqual({ DSH_CODE_BRIDGE: expect.any(String) })
  })
})
