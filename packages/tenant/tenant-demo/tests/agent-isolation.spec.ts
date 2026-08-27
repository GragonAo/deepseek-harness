import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContainerCommandResult } from '@deepseek-ai/dsh-container'
import DockerContainerRuntime from '@deepseek-ai/dsh-container-docker'
import type { DockerRunner, ToolExecClient } from '@deepseek-ai/dsh-container-docker'
import { listenToolExecServer } from '@deepseek-ai/dsh-container-docker'
import type { ListeningToolExecServer, ToolExecRequest, ToolExecResult } from '@deepseek-ai/dsh-container-docker'
import ContainerSubprocessRuntime from '@deepseek-ai/dsh-subprocess-container'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'

function tenant(id: string): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/workspace/${id}`,
    toolsRoot: `/tools/${id}`,
  }
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function bashToolChunks(command: string): StreamChunk[] {
  const callId = CallId('c1')
  const argumentsJson = JSON.stringify({ command, description: 'Print a container marker' })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'bash', argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'bash', arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

class FakeRunner implements DockerRunner {
  readonly calls: string[][] = []

  constructor(private readonly port: number) {}

  async run(args: readonly string[]): Promise<ContainerCommandResult> {
    this.calls.push([...args])
    if (args[0] === 'run') {
      const nameIndex = args.indexOf('--name')
      return { exitCode: 0, stdout: args[nameIndex + 1] ?? 'missing', stderr: '' }
    }
    if (args[0] === 'port') {
      return { exitCode: 0, stdout: `127.0.0.1:${String(this.port)}`, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

/** Records the /exec request and answers with a scripted result (no HTTP). */
class RecordingClient implements ToolExecClient {
  readonly requests: { baseUrl: string; req: ToolExecRequest }[] = []

  async exec(baseUrl: string, req: ToolExecRequest): Promise<ToolExecResult> {
    this.requests.push({ baseUrl, req })
    return { exitCode: 0, stdout: 'container-ok', stderr: '' }
  }
}

async function bootContainerStack(
  runner: DockerRunner,
  adapter: ScriptedAdapter,
  client?: ToolExecClient,
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'You are a test agent.' } })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContainerSubprocessRuntime)
  // Direct-construct so the test runner/client actually reach the constructor:
  // ctx.plugin() forwards only config, not extra constructor args.
  new DockerContainerRuntime(ctx, { runtime: 'docker' }, runner, client)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { cwd: process.cwd(), timeoutMs: 30_000 })
  await ctx.plugin(ToolBash)
  return ctx
}

async function promptAndIdle(ctx: Context, sessionId: string): Promise<Agent> {
  const agent = (await ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  return agent
}

function finalText(events: readonly SessionEvent[]): string {
  const message = events.findLast(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') return ''
  return message.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function eventLogText(events: readonly SessionEvent[]): string {
  return JSON.stringify(events)
}

let toolExec: ListeningToolExecServer

beforeAll(async () => {
  toolExec = await listenToolExecServer(0, '127.0.0.1')
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    toolExec.server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
})

describe('multi-tenant agent container tool execution', () => {
  it('completes a no-tool turn without ever starting a container', async () => {
    const runner = new FakeRunner(toolExec.port)
    const adapter = new ScriptedAdapter([textChunks('zero tools')])
    const ctx = await bootContainerStack(runner, adapter)
    try {
      const agent = await runWithTenant(tenant('globex'), () => promptAndIdle(ctx, 'no-tool-turn'))
      expect(finalText(agent.session.events)).toBe('zero tools')
      expect(runner.calls).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lazily starts the tenant container and routes a bash tool call to /exec', async () => {
    const runner = new FakeRunner(toolExec.port)
    const client = new RecordingClient()
    const adapter = new ScriptedAdapter([bashToolChunks('printf container-ok'), textChunks('done')])
    const ctx = await bootContainerStack(runner, adapter, client)
    try {
      const agent = await runWithTenant(tenant('acme'), () => runWithUser(UserId('user-1'), () => promptAndIdle(ctx, 'tool-turn')))

      // Lazy: one docker run publishing the loopback port, one port read, no docker exec.
      expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(1)
      expect(runner.calls.some(c => c[0] === 'port')).toBe(true)
      expect(runner.calls.some(c => c[0] === 'exec')).toBe(false)
      const runArgs = runner.calls.find(c => c[0] === 'run')
      expect(runArgs).toContain('127.0.0.1::8642')
      expect(runArgs).toContain('/workspace/acme/users/user-1:/workspace')
      expect(runArgs).toContain('/workspace/acme/shared:/shared')
      expect(runArgs).toContain('/tools/acme:/tools:ro')

      // The tool reached the container world through requireTenant() and was
      // routed to the published loopback address as an /exec request; the first
      // request is the cold-start readiness probe, the second the actual command.
      expect(client.requests).toHaveLength(2)
      expect(client.requests[0]?.req.argv).toEqual(['sh', '-c', 'true'])
      expect(client.requests[1]?.baseUrl).toBe(`http://127.0.0.1:${String(toolExec.port)}`)
      expect(client.requests[1]?.req.argv).toEqual(['bash', '-c', 'printf container-ok'])

      // The tool result flowed back into the session log and the model answered.
      expect(eventLogText(agent.session.events)).toContain('container-ok')
      expect(finalText(agent.session.events)).toBe('done')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('executes /exec over the live tool-exec HTTP server (real ip+host round trip)', async () => {
    const runner = new FakeRunner(toolExec.port)
    const ctx = new Context()
    new DockerContainerRuntime(ctx, { runtime: 'docker' }, runner)
    try {
      const result = await runWithTenant(tenant('acme'), () => runWithUser(UserId('user-1'), () => ctx.containerRuntime.exec('sh', ['-c', 'printf direct-ok'])))
      expect(result).toEqual({ exitCode: 0, stdout: 'direct-ok', stderr: '' })
      expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(1)
      expect(runner.calls.some(c => c[0] === 'port')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
