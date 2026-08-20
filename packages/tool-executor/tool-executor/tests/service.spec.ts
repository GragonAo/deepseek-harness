import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolBodyId, ToolExecutor } from '@deepseek-ai/dsh-tool-executor'
import type { ToolExecutionOutcome, ToolExecutionRequest } from '@deepseek-ai/dsh-tool-executor'

/**
 * Minimal concrete executor: records requests, "executes" by returning the
 * scripted outcome. The Service Definition package ships no provider, so the
 * contract is exercised through the smallest subclass that honors it.
 */
class StubExecutor extends ToolExecutor {
  readonly isolation = 'in-process-stub'
  requests: ToolExecutionRequest[] = []
  nextOutcome: ToolExecutionOutcome = { value: null }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    this.requests.push(request)
    if (request.signal.aborted) {
      return { failure: { kind: 'abort', message: String(request.signal.reason) } }
    }
    if (request.body) {
      return { value: await request.body(request.arguments, { signal: request.signal }) }
    }
    return this.nextOutcome
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(StubExecutor)
  const executor = ctx.toolExecutor as StubExecutor
  return { ctx, executor }
}

describe('ToolExecutor service seam', () => {
  it('registers as ctx.toolExecutor and serves the abstract API', async () => {
    const { executor } = await setup()
    expect(executor.isolation).toBe('in-process-stub')

    const result = await executor.execute({
      toolId: ToolBodyId('stub'),
      arguments: { probe: true },
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ value: null })
    expect(executor.requests).toHaveLength(1)
    expect(executor.requests[0]?.toolId).toBe(ToolBodyId('stub'))
    expect(executor.requests[0]?.arguments).toEqual({ probe: true })
  })

  it('reports a failed execution as a failure field on a resolved outcome, never a rejection', async () => {
    const { executor } = await setup()
    executor.nextOutcome = { failure: { kind: 'exception', message: 'boom' } }
    const result = await executor.execute({
      toolId: ToolBodyId('stub'),
      arguments: null,
      signal: new AbortController().signal,
    })
    expect(result.failure).toEqual({ kind: 'exception', message: 'boom' })
    expect(result.value).toBeUndefined()
  })

  it('runs an in-process body passed inline on the request', async () => {
    const { executor } = await setup()
    const n = 2
    const result = await executor.execute({
      toolId: ToolBodyId('stub'),
      arguments: { n },
      signal: new AbortController().signal,
      body: async args => ({ doubled: (args as { n: number }).n * 2 }),
    })
    expect(result).toEqual({ value: { doubled: 4 } })
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

  it('is removed from the context when the providing fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubExecutor)
    expect(ctx.get('toolExecutor')).toBeInstanceOf(StubExecutor)

    await fiber.dispose()
    expect(ctx.get('toolExecutor')).toBeUndefined()
  })

  it('rejects a second implementation in the same context (duplicate service)', async () => {
    const { ctx } = await setup()
    await expect(ctx.plugin(StubExecutor)).rejects.toThrow(/registered/)
  })
})
