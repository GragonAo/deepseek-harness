import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ContainerRuntime from '../src/index.ts'

class FakeRuntime extends ContainerRuntime {
  async exec(command: string, _args: readonly string[]) {
    return { exitCode: 0, stdout: command, stderr: '' }
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
