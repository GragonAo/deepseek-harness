import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import InProcessToolExecutor from '@deepseek-ai/dsh-tool-executor-in-process'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const testToolSignal = new AbortController().signal

const echoTool = defineTool({
  name: 'echo',
  description: 'echo arguments back',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    return args.text ?? ''
  },
})

async function setup(withExecutor: boolean) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withExecutor) await ctx.plugin(InProcessToolExecutor)
  ctx.tools.register(echoTool)
  return ctx
}

describe('tool-execution seam wiring', () => {
  it('executes a tool through the in-process executor with identical content', async () => {
    const ctx = await setup(true)
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }], isError: false, value: 'hi' })
  })

  it('falls back to direct dispatch when no executor is mounted', async () => {
    const ctx = await setup(false)
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('c1'), name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }], isError: false, value: 'hi' })
  })

  it('matches direct dispatch error output when a body rejects (zero behavior change)', async () => {
    const direct = await setup(false)
    const via = await setup(true)
    const input = { signal: testToolSignal, name: 'echo', arguments: { text: 42 } }
    const directResult = await direct.tools.execute({ ...input, callId: CallId('c1') })
    const viaResult = await via.tools.execute({ ...input, callId: CallId('c2') })
    expect(viaResult).toEqual(directResult)
    expect(viaResult.isError).toBe(true)
  })
})
