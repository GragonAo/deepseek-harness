import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolBodyId } from '@deepseek-ai/dsh-tool-executor'
import { InProcessToolExecutor } from '@deepseek-ai/dsh-tool-executor-in-process'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(InProcessToolExecutor)
  const executor = ctx.toolExecutor as InProcessToolExecutor
  return { ctx, executor }
}

describe('InProcessToolExecutor provider', () => {
  it('registers as ctx.toolExecutor with in-process isolation', async () => {
    const { executor } = await setup()
    expect(executor.isolation).toBe('in-process')
  })

  it('runs the inline body and returns its canonical value', async () => {
    const { executor } = await setup()
    const result = await executor.execute({
      toolId: ToolBodyId('stub'),
      arguments: { probe: true },
      signal: new AbortController().signal,
      body: async args => args,
    })
    expect(result).toEqual({ value: { probe: true } })
  })

  it('propagates a local body rejection unchanged (zero behavior change)', async () => {
    const { executor } = await setup()
    const boom = new Error('boom')
    await expect(executor.execute({
      toolId: ToolBodyId('stub'),
      arguments: null,
      signal: new AbortController().signal,
      body: async () => { throw boom },
    })).rejects.toBe(boom)
  })

  it('reports a pre-aborted signal as an abort failure', async () => {
    const { executor } = await setup()
    const controller = new AbortController()
    controller.abort('cancelled')
    const result = await executor.execute({
      toolId: ToolBodyId('stub'),
      arguments: null,
      signal: controller.signal,
    })
    expect(result.failure).toEqual({ kind: 'abort', message: 'cancelled' })
  })

  it('reports a body-less request as an execution-substrate failure', async () => {
    const { executor } = await setup()
    const result = await executor.execute({
      toolId: ToolBodyId('missing'),
      arguments: null,
      signal: new AbortController().signal,
    })
    expect(result.failure?.kind).toBe('execution-substrate')
  })

  it('is removed from the context when the providing fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(InProcessToolExecutor)
    expect(ctx.get('toolExecutor')).toBeInstanceOf(InProcessToolExecutor)

    await fiber.dispose()
    expect(ctx.get('toolExecutor')).toBeUndefined()
  })

  it('rejects a second implementation in the same context (duplicate service)', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(InProcessToolExecutor)).rejects.toThrow(/registered/)
  })
})
