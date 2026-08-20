import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ProcessToolExecutor from '@deepseek-ai/dsh-tool-executor-process'

const signal = new AbortController().signal

// Each registry tool's name resolves in the WORKER's own body registry; the
// agent-plane `execute` body is a sentinel that must never run.
const pidTool = defineTool({
  name: 'exec:pid',
  description: 'report the execution worker process id',
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { pid: { type: 'number', required: true } } },
    render: (_args, value) => [{ type: 'text', text: String(value.pid) }],
  },
  async execute() {
    throw new Error('agent-plane body must not run')
  },
})

const echoTool = defineTool({
  name: 'exec:echo',
  description: 'echo arguments back with the worker pid',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { echoed: { type: 'object', additionalProperties: true, required: true }, pid: { type: 'number', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `echoed from pid ${String((value as { pid: number }).pid)}` }],
  },
  async execute() {
    throw new Error('agent-plane body must not run')
  },
})

const waitTool = defineTool({
  name: 'exec:wait',
  description: 'hang until cancelled',
  parameters: {},
  output: { schema: { type: 'null' }, render: () => [] },
  async execute() {
    throw new Error('agent-plane body must not run')
  },
})

const missingTool = defineTool({
  name: 'exec:missing',
  description: 'no worker body registered under this name',
  parameters: {},
  output: { schema: { type: 'null' }, render: () => [] },
  async execute() {
    throw new Error('agent-plane body must not run')
  },
})

const contexts: Context[] = []

async function setup(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ProcessToolExecutor)
  ctx.tools.register(pidTool)
  ctx.tools.register(echoTool)
  ctx.tools.register(waitTool)
  ctx.tools.register(missingTool)
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('process tool executor', () => {
  it('runs a tool body in a separate process', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({ signal, callId: CallId('c1'), name: 'exec:pid', arguments: {} })
    expect(result.isError).toBe(false)
    const pid = (result.value as { pid: number }).pid
    expect(pid).toBeTypeOf('number')
    expect(pid).not.toBe(process.pid)
  })

  it('round-trips arguments through the worker', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({ signal, callId: CallId('c2'), name: 'exec:echo', arguments: { text: 'hi' } })
    expect(result.isError).toBe(false)
    const value = result.value as { echoed: { text: string }; pid: number }
    expect(value.echoed).toEqual({ text: 'hi' })
    expect(value.pid).toBeTypeOf('number')
  })

  it('fails a pre-aborted signal without calling the worker', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await ctx.tools.execute({ signal: controller.signal, callId: CallId('c3'), name: 'exec:pid', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('abort')
  })

  it('aborts an in-flight execution', async () => {
    const ctx = await setup()
    // Warm the worker so the wait call below is genuinely in-flight, not still
    // awaiting the worker's `ready` frame.
    await ctx.tools.execute({ signal, callId: CallId('warm'), name: 'exec:pid', arguments: {} })
    const controller = new AbortController()
    const pending = ctx.tools.execute({ signal: controller.signal, callId: CallId('c4'), name: 'exec:wait', arguments: {} })
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('abort')
  })

  it('reports an unknown tool as an execution failure', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({ signal, callId: CallId('c5'), name: 'exec:missing', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('unknown tool')
  })

  it('disposes to quiescence, failing in-flight calls', async () => {
    const ctx = await setup()
    // Warm the worker so the wait call below is genuinely in-flight, not still
    // awaiting the worker's `ready` frame.
    await ctx.tools.execute({ signal, callId: CallId('warm2'), name: 'exec:pid', arguments: {} })
    const controller = new AbortController()
    const pending = ctx.tools.execute({ signal: controller.signal, callId: CallId('c6'), name: 'exec:wait', arguments: {} })
    await new Promise(resolve => setTimeout(resolve, 20))
    await ctx.fiber.dispose()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('disposed')
  })
})
