import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { Config as ToolsConfig, ToolDefinition } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { CallId } from '@deepseek-ai/dsh-llm'
import { apply as applyToolTier } from '@deepseek-ai/dsh-tools-tier'
import { apply as applyToolsManifest } from '@deepseek-ai/dsh-tools-manifest'
import { apply as applyRestriction } from '../src/index.ts'
import type { Config as RestrictionConfig } from '../src/index.ts'
import * as restrictionPlugin from '../src/index.ts'
import { isRestrictionFile, parseRestriction, expandRestriction, MAX_EXPANDED_NAMES_PER_ENTRY } from '../src/restriction.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const testToolSignal = new AbortController().signal

async function harness(options: { mode?: ToolsConfig['mode'] } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry, { ...options.mode !== undefined ? { mode: options.mode } : {} })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.mode !== undefined && options.mode !== 'native') await ctx.plugin(FakeRuntime)
  return ctx
}

/** An in-repo CodeRuntime: the assembled SDK section is what these tests read, not a program's result. */
class FakeRuntime extends CodeRuntime {
  readonly language = 'typescript'

  readonly isolation = 'fake'

  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

/** One tool's rendered text result, the way the registry materializes it. */
async function run(ctx: Context, name: string, args: Record<string, unknown> = {}, agent?: Agent): Promise<string> {
  const result = await ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId('call-1'),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/** A globally registered tool: the layer a tier restriction masks. */
function globalTool(name: string): ToolDefinition {
  return defineTool({
    name,
    description: `global ${name}`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (): Promise<string> => Promise.resolve(`ran:${name}`),
  })
}

/** A manifest that prints `value` through the current Node executable (portable across CI hosts). */
function echoManifest(name: string, value: string): string {
  const command = JSON.stringify(process.execPath)
  return `name: ${name}\ndescription: prints ${value}\nexecutor:\n  command: ${command}\n  args: ["-e", "process.stdout.write('${value}')"]\n`
}

async function addFile(dir: string, filename: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), content)
}

/** Write one tier directory's restriction document. */
async function addRestriction(dir: string, content: string): Promise<void> {
  await addFile(dir, 'restriction.yaml', content)
}

/** The ambient (tenant, user) tier directories under one host root. */
interface Tiers {
  root: string
  workspace: string
  case: string
  userGlobal: string
  system: string
}

function tiers(root: string): Tiers {
  const workspace = join(root, 'acme-workspace')
  return {
    root,
    workspace,
    case: join(workspace, 'shared', 'tools'),
    userGlobal: join(root, 'users', 'user-1', 'tools'),
    system: join(root, 'system', 'tools'),
  }
}

function tenantOf(layout: Tiers): Tenant {
  return { id: TenantId('acme'), name: 'acme', dataRoot: '/data/acme', workspaceRoot: layout.workspace }
}

/** Mount the ambient tier provider and the restriction plugin against one host root. */
async function mountTiers(ctx: Context, layout: Tiers): Promise<void> {
  await ctx.plugin(applyToolTier, { usersRoot: join(layout.root, 'users'), systemToolsDir: layout.system })
  await ctx.plugin(restrictionPlugin)
}

describe('parseRestriction', () => {
  it('reads allow and deny lists, including an allow that admits nothing', () => {
    expect(parseRestriction('allow: [a, b]\ndeny: [c]\n', 'restriction.yaml')).toEqual({
      allow: [{ kind: 'name', declared: 'a' }, { kind: 'name', declared: 'b' }],
      deny: [{ kind: 'name', declared: 'c' }],
    })
    expect(parseRestriction('allow: []\n', 'restriction.yaml')).toEqual({ allow: [] })
    expect(parseRestriction('deny:\n  - mcp__mining__drop_table\n', 'restriction.yaml'))
      .toEqual({ deny: [{ kind: 'name', declared: 'mcp__mining__drop_table' }] })
  })

  it('classifies a trailing star as a prefix pattern and keeps exact names beside it', () => {
    expect(parseRestriction('allow: [mcp__icac-bill__*, exact]\n', 'restriction.yaml')).toEqual({
      allow: [
        { kind: 'pattern', declared: 'mcp__icac-bill__*', prefix: 'mcp__icac-bill__' },
        { kind: 'name', declared: 'exact' },
      ],
    })
  })

  it('rejects a document that narrows nothing, an unknown field, a malformed list, and a non-mapping', () => {
    expect(() => parseRestriction('{}\n', 'restriction.yaml')).toThrow(/neither `allow` nor `deny`/)
    expect(() => parseRestriction('tools: [a]\n', 'restriction.yaml')).toThrow(/unknown field "tools"/)
    expect(() => parseRestriction('deny: bash\n', 'restriction.yaml')).toThrow(/list of non-empty tool names/)
    expect(() => parseRestriction('deny: [""]\n', 'restriction.yaml')).toThrow(/list of non-empty tool names/)
    expect(() => parseRestriction('- a\n', 'restriction.yaml')).toThrow(/must be a mapping/)
  })

  it('refuses every wildcard but one trailing star, naming the file and the entry', () => {
    const illegal = ['mcp__*__search', '*', 'mcp__icac-?ill__*', 'mcp__icac-bill__[a-z]*', 'mcp__icac-bill__a|b', 'mcp__\\d+']
    for (const entry of illegal) {
      // The syntax is one trailing `*`, so a document cannot express a pattern language to review as a name.
      expect(() => parseRestriction(`allow: [${JSON.stringify(entry)}]\n`, 'case/tools/restriction.yaml'))
        .toThrow(/case\/tools\/restriction\.yaml: /)
    }
    expect(() => parseRestriction('allow: ["mcp__a*b"]\n', 'restriction.yaml')).toThrow(/has a `\*` that is not at its end/)
    expect(() => parseRestriction('allow: ["*"]\n', 'restriction.yaml')).toThrow(/expands from an empty prefix/)
    expect(() => parseRestriction('allow: ["mcp__a?"]\n', 'restriction.yaml')).toThrow(/contains "\?"; every character but a trailing `\*` is literal/)
  })

  it('reserves the two restriction basenames and no manifest name', () => {
    expect(isRestrictionFile('restriction.yaml')).toBe(true)
    expect(isRestrictionFile('restriction.yml')).toBe(true)
    expect(isRestrictionFile('probe.yaml')).toBe(false)
  })
})

describe('expandRestriction', () => {
  const held = ['mcp__icac-bill__list', 'mcp__icac-bill__get', 'mcp__icac-case__search', 'plain']

  it('expands a prefix to the exact names it matches, and passes exact names through', () => {
    const document = parseRestriction('allow: [mcp__icac-bill__*, plain]\n', 'restriction.yaml')
    expect(expandRestriction(document, held, 'restriction.yaml'))
      .toEqual({ allow: ['mcp__icac-bill__get', 'mcp__icac-bill__list', 'plain'] })
  })

  it('fails when a prefix matches nothing, naming the file and the pattern', () => {
    const document = parseRestriction('allow: [mcp__icac-blll__*]\n', 'case/tools/restriction.yaml')
    expect(() => expandRestriction(document, held, 'case/tools/restriction.yaml'))
      .toThrow(/case\/tools\/restriction\.yaml: `mcp__icac-blll__\*` matches none of the 4/)
    expect(() => expandRestriction(document, held, 'case/tools/restriction.yaml'))
      .toThrow(/registered global tools \(mcp__icac-bill__get, mcp__icac-bill__list, mcp__icac-case__search, plain\)/)
  })

  it('fails when one entry expands past the bound instead of applying a shortened prefix', () => {
    const wide = Array.from({ length: MAX_EXPANDED_NAMES_PER_ENTRY + 1 }, (_unused, index) => `mcp__x__${index}`)
    const document = parseRestriction('deny: [mcp__x__*]\n', 'restriction.yaml')
    expect(() => expandRestriction(document, wide, 'restriction.yaml'))
      .toThrow(/`mcp__x__\*` expands to 513 global tools, over the 512-name bound/)
    expect(expandRestriction(document, wide.slice(1), 'restriction.yaml').deny).toHaveLength(MAX_EXPANDED_NAMES_PER_ENTRY)
  })
})

describe('tools-restriction tier application', () => {
  it('narrows one case to the ten tools it declares, leaving the other registrations callable nowhere', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    const admitted = Array.from({ length: 10 }, (_unused, index) => `tool-${String(index).padStart(2, '0')}`)
    await addRestriction(layout.case, `allow: [${admitted.join(', ')}]\n`)

    const ctx = await harness({ mode: 'native' })
    const all = [...admitted, 'tool-10', 'tool-11']
    for (const name of all) ctx.tools.register(globalTool(name))
    await mountTiers(ctx, layout)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      const { agent, dispose } = await scopedAgent(ctx, 'ten-tools')
      try {
        // The visible set IS the declaration: same names in the prompt's tool list and in dispatch.
        expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(admitted)
        expect(await run(ctx, admitted[0]!, {}, agent)).toBe(`ran:${admitted[0]}`)
        expect(await run(ctx, 'tool-10', {}, agent)).toBe('Error: unknown tool "tool-10"')
        expect(await run(ctx, 'tool-11', {}, agent)).toBe('Error: unknown tool "tool-11"')
        // The mask belongs to that agent's scope: the global view still holds every registration.
        expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([...all].sort())
      } finally {
        dispose()
      }
    }))
    await ctx.fiber.dispose()
  })

  it('composes the three tiers by intersection, so no tier re-admits a name another tier masked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.system, 'deny: [c]\n')
    await addRestriction(layout.userGlobal, 'allow: [a, b, c, d]\n')
    await addRestriction(layout.case, 'allow: [a, b, c]\n')

    const ctx = await harness({ mode: 'native' })
    for (const name of ['a', 'b', 'c', 'd']) ctx.tools.register(globalTool(name))
    await mountTiers(ctx, layout)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      const { agent, dispose } = await scopedAgent(ctx, 'intersection')
      try {
        // The case cannot widen what the system tier removed, and the user-global allow cannot add `d`.
        expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['a', 'b'])
        expect(await run(ctx, 'c', {}, agent)).toBe('Error: unknown tool "c"')
        expect(await run(ctx, 'd', {}, agent)).toBe('Error: unknown tool "d"')
      } finally {
        dispose()
      }
    }))
    await ctx.fiber.dispose()
  })

  it('shrinks the native tool list and the generated SDK declaration together under a both-mode prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.case, 'deny: [drop]\n')

    const ctx = await harness({ mode: 'both' })
    for (const name of ['keep', 'drop']) ctx.tools.register(globalTool(name))
    await mountTiers(ctx, layout)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      const { agent, dispose } = await scopedAgent(ctx, 'both-mode')
      try {
        const assembly = await ctx.systemPrompt.assemble({ scope: agent })
        const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
        // Both presentations render the same visible map, so both lose the masked name.
        expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['keep', RUN_CODE_NAME])
        expect(sdk).toContain('keep: Record<string, JsonValue>')
        expect(sdk).not.toContain('drop')
        expect(await run(ctx, 'keep', {}, agent)).toBe('ran:keep')
        expect(await run(ctx, 'drop', {}, agent)).toBe('Error: unknown tool "drop"')
      } finally {
        dispose()
      }
    }))
    await ctx.fiber.dispose()
  })

  it('fails the creation of an agent whose tier names a tool the registry does not have, naming the document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.case, 'allow: [keep, ghost]\n')

    const ctx = await harness({ mode: 'native' })
    ctx.tools.register(globalTool('keep'))
    await mountTiers(ctx, layout)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      // The registry's own diagnostic survives, and the file the operator must edit is attached to it.
      await expect(scopedAgent(ctx, 'ghost')).rejects.toThrow(/restriction\.yaml: .*unknown global tool "ghost"/)
    }))
    await ctx.fiber.dispose()
  })

  it('expands a case prefix against the registry, admitting the group it names beside an exact name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.case, 'allow: [mcp__icac-bill__*, mcp__icac-case__search]\n')

    const ctx = await harness({ mode: 'native' })
    const registered = [
      'mcp__icac-bill__list',
      'mcp__icac-bill__get',
      'mcp__icac-case__search',
      'mcp__icac-case__close',
      'other',
    ]
    for (const name of registered) ctx.tools.register(globalTool(name))
    await mountTiers(ctx, layout)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      const { agent, dispose } = await scopedAgent(ctx, 'prefix-group')
      try {
        // The pattern became exact names before the registry saw it, so the whole group is visible and nothing else is.
        expect(ctx.tools.schemas(agent).map(tool => tool.name).sort())
          .toEqual(['mcp__icac-bill__get', 'mcp__icac-bill__list', 'mcp__icac-case__search'])
        expect(await run(ctx, 'mcp__icac-bill__get', {}, agent)).toBe('ran:mcp__icac-bill__get')
        expect(await run(ctx, 'mcp__icac-case__close', {}, agent)).toBe('Error: unknown tool "mcp__icac-case__close"')
      } finally {
        dispose()
      }
    }))
    await ctx.fiber.dispose()
  })

  it('fails the creation of an agent whose prefix matches nothing, naming the document and the pattern', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.case, 'allow: [keep, mcp__icac-absent__*]\n')

    const ctx = await harness({ mode: 'native' })
    ctx.tools.register(globalTool('keep'))
    await mountTiers(ctx, layout)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      // A prefix matching nothing would otherwise read as an allow that admits nothing at all.
      await expect(scopedAgent(ctx, 'no-match')).rejects
        .toThrow(/restriction\.yaml: `mcp__icac-absent__\*` matches none of the 1 registered global tool \(keep\)/)
    }))
    await ctx.fiber.dispose()
  })

  it('expands a prefix to the global group only, so a same-prefix manifest tool stays visible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addFile(layout.case, 'probe.yaml', echoManifest('mcp__icac-bill__probe', 'case'))
    await addRestriction(layout.case, 'allow: [mcp__icac-bill__*]\n')

    const ctx = await harness({ mode: 'native' })
    ctx.tools.register(globalTool('mcp__icac-bill__list'))
    await ctx.plugin(applyToolTier, { usersRoot: join(root, 'users'), systemToolsDir: layout.system })
    await ctx.plugin(applyToolsManifest, { defaultCwd: process.cwd() })
    await ctx.plugin(restrictionPlugin)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      const { agent, dispose } = await scopedAgent(ctx, 'prefix-and-manifest')
      try {
        // Only the global group is a restrictable name, so the pattern matches it and the tier's own tool is never expanded away.
        expect(ctx.tools.schemas(agent).map(tool => tool.name).sort())
          .toEqual(['mcp__icac-bill__list', 'mcp__icac-bill__probe'])
        expect(await run(ctx, 'mcp__icac-bill__probe', {}, agent)).toBe('case')
      } finally {
        dispose()
      }
    }))
    await ctx.fiber.dispose()
  })

  it('rejects an illegal pattern in the system document at load, before any agent exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.system, 'deny: [mcp__icac-*__search]\n')

    const ctx = await harness({ mode: 'native' })
    await ctx.plugin(applyToolTier, { usersRoot: join(root, 'users'), systemToolsDir: layout.system })
    await expect(ctx.plugin(restrictionPlugin)).rejects
      .toThrow(/restriction\.yaml: "mcp__icac-\*__search" has a `\*` that is not at its end/)
    await ctx.fiber.dispose()
  })

  it('rejects a malformed system document at load, and any config key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.system, 'tools: [a]\n')

    const ctx = await harness({ mode: 'native' })
    await ctx.plugin(applyToolTier, { usersRoot: join(root, 'users'), systemToolsDir: layout.system })
    // The system tier resolves without an ambient tenant, so the operator's typo fails at load.
    await expect(ctx.plugin(restrictionPlugin)).rejects.toThrow(/unknown field "tools"/)
    expect(() => applyRestriction(ctx, { roots: '/etc/tools' } as unknown as RestrictionConfig))
      .toThrow(/unknown config key "roots"/)
    await ctx.fiber.dispose()
  })

  it('keeps a tier manifest tool visible beside a masked global, whatever order the listeners ran in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addFile(layout.case, 'probe.yaml', echoManifest('probe', 'case'))
    await addRestriction(layout.case, 'allow: [keep]\n')

    const ctx = await harness({ mode: 'native' })
    for (const name of ['keep', 'drop']) ctx.tools.register(globalTool(name))
    await ctx.plugin(applyToolTier, { usersRoot: join(root, 'users'), systemToolsDir: layout.system })
    await ctx.plugin(applyToolsManifest, { defaultCwd: process.cwd() })
    await ctx.plugin(restrictionPlugin)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      const { agent, dispose } = await scopedAgent(ctx, 'manifest-and-restriction')
      try {
        // The tier's own manifest tool lives in the agent's scope, outside the inherited filter.
        expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['keep', 'probe'])
        expect(await run(ctx, 'probe', {}, agent)).toBe('case')
        expect(await run(ctx, 'drop', {}, agent)).toBe('Error: unknown tool "drop"')
      } finally {
        dispose()
      }
    }))
    await ctx.fiber.dispose()
  })

  it('fails when a document names a tool that only the same tier manifest contributes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addFile(layout.case, 'probe.yaml', echoManifest('probe', 'case'))
    await addRestriction(layout.case, 'deny: [probe]\n')

    const ctx = await harness({ mode: 'native' })
    await ctx.plugin(applyToolTier, { usersRoot: join(root, 'users'), systemToolsDir: layout.system })
    await ctx.plugin(applyToolsManifest, { defaultCwd: process.cwd() })
    await ctx.plugin(restrictionPlugin)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      // Manifest tools are registered into the agent's own scope and are never restrictable names.
      await expect(scopedAgent(ctx, 'own-layer-name')).rejects.toThrow(/unknown global tool "probe"/)
    }))
    await ctx.fiber.dispose()
  })

  it('stops restricting agents once its fiber is disposed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tools-restriction-'))
    roots.push(root)
    const layout = tiers(root)
    await addRestriction(layout.case, 'deny: [drop]\n')

    const ctx = await harness({ mode: 'native' })
    for (const name of ['keep', 'drop']) ctx.tools.register(globalTool(name))
    await ctx.plugin(applyToolTier, { usersRoot: join(root, 'users'), systemToolsDir: layout.system })
    const fiber = await ctx.plugin(restrictionPlugin)

    await runWithTenant(tenantOf(layout), () => runWithUser(UserId('user-1'), async () => {
      const restricted = await scopedAgent(ctx, 'before-disposal')
      try {
        expect(ctx.tools.schemas(restricted.agent).map(tool => tool.name).sort()).toEqual(['keep'])
      } finally {
        restricted.dispose()
      }
      await fiber.dispose()
      const after = await scopedAgent(ctx, 'after-disposal')
      try {
        expect(ctx.tools.schemas(after.agent).map(tool => tool.name).sort()).toEqual(['drop', 'keep'])
      } finally {
        after.dispose()
      }
    }))
    await ctx.fiber.dispose()
  })
})

interface StubAgent { agent: Agent; dispose: () => void }

/**
 * Register an agent whose own context is a real scope, as the agent factory
 * mints one per created agent. The restriction reaches `agent.ctx`, so a
 * scope-less stub would file it in the global layer instead.
 */
async function scopedAgent(ctx: Context, id: string): Promise<StubAgent> {
  const session = ctx.sessions.create(SessionId(id))
  const stub = {
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
  }
  const scope = await mintScope(ctx, stub as unknown as Agent)
  stub.ctx = scope.ctx
  const agent = stub as unknown as Agent
  return { agent, dispose: ctx.agents.register(agent) }
}

/** Mint a scope keyed by one agent; the minter injects what scope holders reach. */
async function mintScope(ctx: Context, key: Agent): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return scope
}
