import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContainerPtyOptions, ContainerPtySession } from '../src/index.ts'
import ContainerRuntime from '../src/index.ts'

class FakeRuntime extends ContainerRuntime {
  async exec(command: string, _args: readonly string[]) {
    return { exitCode: 0, stdout: command, stderr: '' }
  }

  async openPty(_options: ContainerPtyOptions): Promise<ContainerPtySession> {
    throw new Error('FakeRuntime: no interactive session')
  }
}

describe('ContainerRuntime', () => {
  it('mounts as ctx.containerRuntime and executes', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeRuntime)
    expect(ctx.containerRuntime).toBeInstanceOf(ContainerRuntime)
    await expect(ctx.containerRuntime.exec('echo', ['hi'])).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'echo',
    })
  })
})
