import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import ApiProxyService from '@deepseek-ai/dsh-host-apiproxy'
import AgentHttp from '@deepseek-ai/dsh-agent-http'
import JwtTenantAuthenticator from '@deepseek-ai/dsh-tenant-auth-jwt'
import { TenantId, TenantRegistry } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import DockerContainerRuntime from '@deepseek-ai/dsh-container-docker'
import type { DockerRunner, ToolExecClient, ToolExecRequest } from '@deepseek-ai/dsh-container-docker'
import ContainerSubprocessRuntime from '@deepseek-ai/dsh-subprocess-container'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContainerCommandResult } from '@deepseek-ai/dsh-container'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'

const SECRET = 'http-parity-test-secret'
const ISSUER = 'http-parity-test'

function tenant(id: string): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/workspace/${id}`,
    toolsRoot: `/tools/${id}`,
  }
}

async function issueToken(tenantId: string): Promise<string> {
  const payload: JWTPayload = { sub: 'user-1', tenantId }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
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

  async run(args: readonly string[]): Promise<ContainerCommandResult> {
    this.calls.push([...args])
    if (args[0] === 'run') {
      const nameIndex = args.indexOf('--name')
      return { exitCode: 0, stdout: args[nameIndex + 1] ?? 'missing', stderr: '' }
    }
    if (args[0] === 'port') {
      return { exitCode: 0, stdout: '127.0.0.1:8642', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

class RecordingClient implements ToolExecClient {
  readonly requests: Array<{ baseUrl: string; req: ToolExecRequest }> = []

  async exec(baseUrl: string, req: ToolExecRequest): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.requests.push({ baseUrl, req })
    return { exitCode: 0, stdout: 'container-ok', stderr: '' }
  }
}

/** A service registered under one name with no methods, for gateway services a prompt never touches. */
class StubService extends Service {}

/** The gateway's ask-user provider is registered eagerly; this stub records the disposer contract. */
class UserQuestionsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
  }

  registerProvider(_provider: unknown): () => void {
    return () => {}
  }
}

async function boot(adapter: ScriptedAdapter, runner: DockerRunner, client?: ToolExecClient): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'You are a test agent.' } })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
  await ctx.plugin(ContainerSubprocessRuntime)
  // Direct-construct so the test runner/client reach the constructor; ctx.plugin forwards only config.
  new DockerContainerRuntime(ctx, { runtime: 'docker' }, runner, client)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { cwd: process.cwd(), timeoutMs: 30_000 })
  await ctx.plugin(ToolBash)
  // Gateway prerequisites: the services a prompt never reaches stay stubbed; the ask-user
  // provider is registered at gateway construction.
  new StubService(ctx, 'attachments')
  new StubService(ctx, 'directoryPicker')
  new StubService(ctx, 'subagents')
  new StubService(ctx, 'sessionQuery')
  new StubService(ctx, 'workspaceRegistry')
  new UserQuestionsStub(ctx)
  await ctx.plugin(ApiProxyService, {})
  await ctx.plugin(JwtTenantAuthenticator, { issuer: ISSUER, secret: SECRET })
  await ctx.plugin(TenantRegistry)
  ctx.tenants.register(tenant('acme'))
  await ctx.plugin(AgentHttp)
  return ctx
}

function rpcRequest(method: string, rpcId: string, token: string, payload: unknown): Request {
  return new Request(`http://localhost/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
}

interface RpcValue<T> {
  result: { ok: boolean; value?: T }
}

async function createSession(ctx: Context, token: string): Promise<string> {
  const response = await ctx.agentHttp.fetch(rpcRequest('session.create', 'r-create', token, {}))
  expect(response.status).toBe(200)
  const body = await response.json() as RpcValue<{ sessionId: string }>
  expect(body.result.ok).toBe(true)
  return body.result.value!.sessionId
}

function finalText(events: readonly SessionEvent[]): string {
  const message = events.findLast(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') return ''
  return message.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function waitForIdle(ctx: Context, sessionId: string): Promise<void> {
  const agent = ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`agent for session "${sessionId}" was not created`)
  await new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
    if (agent.status === 'idle') {
      dispose()
      resolve()
    }
  })
}

describe('multi-tenant agent HTTP parity', () => {
  it('runs a tool-call prompt over the carrier into a lazily started container', async () => {
    const runner = new FakeRunner()
    const client = new RecordingClient()
    const adapter = new ScriptedAdapter([bashToolChunks('printf container-ok'), textChunks('done')])
    const ctx = await boot(adapter, runner, client)
    try {
      const token = await issueToken('acme')
      const sessionId = await createSession(ctx, token)

      const response = await ctx.agentHttp.fetch(rpcRequest('session.prompt', 'r-prompt', token, {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'go' }],
      }))
      expect(response.status).toBe(200)
      const body = await response.json() as RpcValue<{ accepted: boolean }>
      expect(body.result.value?.accepted).toBe(true)

      await waitForIdle(ctx, sessionId)
      const agent = ctx.agents.get(SessionId(sessionId))
      const events = agent!.session.events

      expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(1)
      expect(runner.calls.some(c => c[0] === 'exec')).toBe(false)
      const runArgs = runner.calls.find(c => c[0] === 'run')
      expect(runArgs).toContain('/workspace/acme/users/user-1:/workspace')
      expect(runArgs).toContain('/workspace/acme/shared:/shared')
      expect(runArgs).toContain('/tools/acme:/tools:ro')

      // Cold-start readiness probe first, then the actual tool command.
      expect(client.requests).toHaveLength(2)
      expect(client.requests[0]?.req.argv).toEqual(['sh', '-c', 'true'])
      expect(client.requests[1]?.req.argv).toEqual(['bash', '-c', 'printf container-ok'])

      expect(JSON.stringify(events)).toContain('container-ok')
      expect(finalText(events)).toBe('done')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('finishes a no-tool prompt over the carrier without starting a container', async () => {
    const runner = new FakeRunner()
    const adapter = new ScriptedAdapter([textChunks('agent-side only')])
    const ctx = await boot(adapter, runner)
    try {
      const token = await issueToken('acme')
      const sessionId = await createSession(ctx, token)

      const response = await ctx.agentHttp.fetch(rpcRequest('session.prompt', 'r-prompt', token, {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'go' }],
      }))
      expect(response.status).toBe(200)

      await waitForIdle(ctx, sessionId)
      const agent = ctx.agents.get(SessionId(sessionId))
      expect(finalText(agent!.session.events)).toBe('agent-side only')
      expect(runner.calls).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
