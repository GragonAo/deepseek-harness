import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { CASE_TOOL_RANK, SYSTEM_TOOL_RANK, USER_GLOBAL_TOOL_RANK } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { CallId } from '@deepseek-ai/dsh-llm'
import { apply as applyToolTier } from '@deepseek-ai/dsh-tools-tier'
import { apply as applyToolsManifest } from '../src/index.ts'
import { parseManifest } from '../src/manifest.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const testToolSignal = new AbortController().signal

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** One tool's rendered text result, the way the registry materializes it. */
async function run(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId('call-1'),
    name,
    arguments: args,
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/** A manifest that prints `value` through the current Node executable (portable across CI hosts). */
function echoManifest(name: string, value: string): string {
  const command = JSON.stringify(process.execPath)
  return `name: ${name}\ndescription: prints ${value}\nexecutor:\n  command: ${command}\n  args: ["-e", "process.stdout.write('${value}')"]\n`
}

async function addManifest(dir: string, filename: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), content)
}

describe('parseManifest', () => {
  it('accepts a minimal command manifest', () => {
    const manifest = parseManifest('name: probe\ndescription: a probe\nexecutor:\n  command: echo\n  args: ["hi"]\n', 'probe.yaml')
    expect(manifest).toEqual({
      name: 'probe',
      description: 'a probe',
      parameters: {},
      executor: { command: 'echo', args: ['hi'] },
    })
  })

  it('rejects non-string parameter types, bad names, and missing fields', () => {
    expect(() => parseManifest('name: Probe\ndescription: x\nexecutor:\n  command: echo\n', 'p.yaml')).toThrow(/kebab-case/)
    expect(() => parseManifest('name: a\ndescription: x\nexecutor:\n  command: echo\n  args: [1]\n', 'p.yaml')).toThrow(/array of strings/)
    expect(() => parseManifest('name: a\ndescription: x\nexecutor:\n  command: echo\n  cwd: 3\n', 'p.yaml')).toThrow(/must be a string/)
    expect(() => parseManifest('name: a\ndescription: x\nparameters:\n  n: { type: number }\nexecutor:\n  command: echo\n', 'p.yaml')).toThrow(/parameter.*\.type.*string/)
  })
})

describe('tools-manifest tier registration', () => {
  it('registers ambient tier manifests with case > user-global > system precedence and union, executing in-subprocess', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-manifest-'))
    roots.push(root)
    const workspace = join(root, 'acme-workspace')
    await addManifest(join(workspace, 'shared', 'tools'), 'probe.yaml', echoManifest('probe', 'case'))
    await addManifest(join(workspace, 'shared', 'tools'), 'only-case.yaml', echoManifest('only_case', 'case-union'))
    await addManifest(join(root, 'users', 'user-1', 'tools'), 'probe.yaml', echoManifest('probe', 'user'))
    await addManifest(join(root, 'users', 'user-1', 'tools'), 'only-user.yaml', echoManifest('only_user', 'user-union'))
    await addManifest(join(root, 'system', 'tools'), 'probe.yaml', echoManifest('probe', 'system'))
    await addManifest(join(root, 'system', 'tools'), 'only-system.yaml', echoManifest('only_system', 'system-union'))

    const ctx = await harness()
    await ctx.plugin(applyToolTier, { usersRoot: join(root, 'users'), systemToolsDir: join(root, 'system', 'tools') })
    await ctx.plugin(applyToolsManifest, { defaultCwd: process.cwd() })

    const tenant: Tenant = { id: TenantId('acme'), name: 'acme', dataRoot: '/data/acme', workspaceRoot: workspace }
    await runWithTenant(tenant, () => runWithUser(UserId('user-1'), async () => {
      const agent = await stubAgent(ctx)
      try {
        // The nearest (case) manifest of a shared name wins; the distinct names union.
        expect(ctx.tools.get('probe')?.description).toContain('case')
        expect(await run(ctx, 'probe')).toBe('case')
        for (const name of ['only_case', 'only_user', 'only_system']) {
          expect(ctx.tools.get(name)).toBeDefined()
        }
        expect(await run(ctx, 'only_user')).toBe('user-union')
        expect(ctx.tools.schemas().map(t => t.name)).toContain('probe')
      } finally {
        agent.dispose()
      }
    }))
    await ctx.fiber.dispose()
  })

  it('asserts the tier rank constants match the configured near-over-far order', () => {
    expect(CASE_TOOL_RANK).toBeLessThan(USER_GLOBAL_TOOL_RANK)
    expect(USER_GLOBAL_TOOL_RANK).toBeLessThan(SYSTEM_TOOL_RANK)
  })
})

interface StubAgent { agent: Agent; dispose: () => void }

async function stubAgent(ctx: Context): Promise<StubAgent> {
  const session = ctx.sessions.create(SessionId('tools-manifest-agent'))
  const agent = {
    id: session.id,
    options: {},
    session,
    status: 'idle',
    acceptsNextStep: false,
    ctx,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  return { agent, dispose: ctx.agents.register(agent) }
}
