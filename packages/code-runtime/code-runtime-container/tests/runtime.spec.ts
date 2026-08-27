import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type { ContainerCommandResult, ContainerExecOptions } from '@deepseek-ai/dsh-container'
import { ContainerCodeRuntime } from '@deepseek-ai/dsh-code-runtime-container'
import type { Config } from '@deepseek-ai/dsh-code-runtime-container'
import type { CodeBindingFunction, CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime'

/**
 * Integration suite over a REAL in-process host bridge plus a LOCAL exec
 * stand-in for the tenant container: it runs the same self-contained
 * bootstrap with `node -e` (on the host loopback, which the suite points
 * `hostBridge` at) so the full transport — argue binding call, bridge HTTP
 * round-trip, frame emission, host parse — runs end to end without Docker.
 */
class LocalExecRuntime extends ContainerRuntime {
  async exec(command: string, args: readonly string[], opts?: ContainerExecOptions): Promise<ContainerCommandResult> {
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
}

async function setup(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalExecRuntime, undefined)
  await ctx.plugin(ContainerCodeRuntime, { hostBridge: '127.0.0.1', ...config })
  return { ctx, runtime: ctx.codeRuntime as ContainerCodeRuntime }
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
    }
    await ctx.plugin(BrokenRuntime, undefined)
    await ctx.plugin(ContainerCodeRuntime, { hostBridge: '127.0.0.1' })
    const runtime = ctx.codeRuntime as ContainerCodeRuntime
    const result = await runtime.run({ program: "console.log('hi')", bindings: [] })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('segfault')
  })
})
