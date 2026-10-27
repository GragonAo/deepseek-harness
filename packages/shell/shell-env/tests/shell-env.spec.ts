/**
 * Registry tests for `@deepseek-ai/dsh-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ShellEnvRegistry, composeDshEnvironment } from '@deepseek-ai/dsh-shell-env'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

/** The one field of an `Agent` these snapshots read: its session identity. */
function agent(sessionId: string): Agent {
  return { session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as Agent
}

/** Install a stand-in agent registry whose ambient initiator reads as given. */
function provideAgents(ctx: Context, currentInitiator: () => Agent | undefined): void {
  ctx.provide('agents', { currentInitiator } as unknown as Context['agents'])
}

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: CallId('bash-env-call'),
    rootCallId: CallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined ? {} : { agent: agent(sessionId) }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })

    expect(registry.collect(execution())).toEqual({
      DSH_HOME: resolve('./test-dsh-home'),
      DSH_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      DSH_HOME: resolve('./test-dsh-home'),
      DSH_SESSION_ID: 'session-a',
      DSH_SHELL: '1',
    })
  })

  it('resolves DSH_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('DSH_HOME', './ambient-dsh-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).DSH_HOME).toBe(resolve('./ambient-dsh-home'))

    vi.stubEnv('DSH_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).DSH_HOME).toBe(join(homedir(), '.dsh'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        DSH_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { DSH_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        DSH_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ DSH_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('DSH_SESSION_OPTIONAL')
    expect(registry.collect(execution()).DSH_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).DSH_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'DSH_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'DSH_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'first',
      variables: { DSH_SHARED: { description: 'First owner.' } },
      resolve: () => ({ DSH_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { DSH_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ DSH_SHARED: 'second' }),
    })).toThrow(/DSH_SHARED.*first.*second|DSH_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    registry.register({
      name: 'declared',
      variables: { DSH_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { DSH_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { DSH_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { dsh_invalid: { description: 'Invalid key.' } } as unknown as Record<'DSH_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { DSH_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { DSH_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { DSH_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ DSH_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*DSH_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { DSH_STRING: { description: 'String fact.' } },
      resolve: () => ({ DSH_STRING: 42 }) as unknown as Record<'DSH_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*DSH_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { DSH_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ DSH_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).DSH_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('DSH_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { DSH_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ DSH_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).DSH_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('DSH_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service and the persistence contributor on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([
      {
        contributor: 'session-persistence',
        description: 'Absolute target path of the current session JSONL when the active persistence backend provides one.',
        key: 'DSH_SESSION_JSONL',
      },
    ])
  })

  it('the persistence contributor resolves DSH_SESSION_JSONL only for a jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      isDeleted: () => false,
      locate: () => ({ kind: 'jsonl' as const, path: 'C:\\sessions\\s.jsonl' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p')).DSH_SESSION_JSONL).toBe('C:\\sessions\\s.jsonl')
  })

  it('the persistence contributor omits the variable for a non-jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      isDeleted: () => false,
      locate: () => ({ kind: 'sqlite' as const, path: 'C:\\sessions\\s.db' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('DSH_SESSION_JSONL')
  })

  it('the persistence contributor omits the variable without a persistence backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('DSH_SESSION_JSONL')
  })
})

describe('composeDshEnvironment', () => {
  it('composes exactly the built-ins the shell path collects for the same facts', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    const facts = { dshHome: resolve('./test-dsh-home'), sessionId: 'session-a' }

    expect(composeDshEnvironment(facts)).toEqual({
      DSH_HOME: resolve('./test-dsh-home'),
      DSH_SESSION_ID: 'session-a',
      DSH_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual(composeDshEnvironment(facts))
  })

  it('omits DSH_SESSION_ID for facts that carry no session', () => {
    expect(composeDshEnvironment({ dshHome: './test-dsh-home' })).toEqual({
      DSH_HOME: './test-dsh-home',
      DSH_SHELL: '1',
    })
  })
})

describe('ShellEnvRegistry.collectSession', () => {
  it('composes the same built-ins, with the session from the ambient initiator', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    provideAgents(ctx, () => agent('ambient-session'))

    expect(registry.collectSession()).toEqual(composeDshEnvironment({
      dshHome: resolve('./test-dsh-home'),
      sessionId: 'ambient-session',
    }))
  })

  it('omits DSH_SESSION_ID without an agent service or an initiator boundary', () => {
    const standalone = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    expect(standalone.collectSession()).toEqual({ DSH_HOME: resolve('./test-dsh-home'), DSH_SHELL: '1' })

    const ctx = new Context()
    const idle = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    provideAgents(ctx, () => undefined)
    expect(idle.collectSession()).not.toHaveProperty('DSH_SESSION_ID')
  })

  it('omits DSH_SESSION_ID when the ambient read rejects', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    provideAgents(ctx, () => { throw new Error('agent registry is disposed') })

    expect(registry.collectSession()).toEqual({ DSH_HOME: resolve('./test-dsh-home'), DSH_SHELL: '1' })
  })

  it('collects no contributor variables because the path holds no tool execution', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin, { dshHome: './test-dsh-home' })
    ctx.provide('sessionPersistence', {
      isDeleted: () => false,
      locate: () => ({ kind: 'jsonl' as const, path: 'C:\\sessions\\s.jsonl' }),
    })
    provideAgents(ctx, () => agent('ambient-session'))

    expect(ctx.shellEnv.collect(execution('ambient-session')).DSH_SESSION_JSONL).toBe('C:\\sessions\\s.jsonl')
    expect(ctx.shellEnv.collectSession()).not.toHaveProperty('DSH_SESSION_JSONL')
  })
})
