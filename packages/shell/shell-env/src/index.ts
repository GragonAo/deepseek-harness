/**
 * Tool-independent managed environment plugin: owns the `ctx.shellEnv` registry
 * of trusted, per-execution `DSH_*` variables, and is the single composer every
 * harness process started in a tenant sandbox receives that group from — the
 * model-facing shell tools (`dsh-tool-bash`, `dsh-tool-pwsh`) and the container
 * code runtime. Built-in shell facts are owned by the registry itself while
 * plugins can register additional, enumerable facts with effect-scoped
 * disposal.
 *
 * @module @deepseek-ai/dsh-shell-env
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type { DshEnvironment, DshEnvironmentKey } from '@deepseek-ai/dsh-shell'
import { DSH_HOME_ENV, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shellEnv: ShellEnvRegistry
  }
}

export const name = 'shell-env'
export const inject: string[] = []

/** Plugin config (all optional — the built-in facts resolve without defaults). */
export interface Config {
  /** DeepSeek Harness home directory exposed as `DSH_HOME`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Runtime configuration schema for the shell-env plugin. */
export const Config: z<Config> = z.object({
  dshHome: z.string(),
})

/** Model-visible metadata for one managed `DSH_*` environment variable. */
export interface BashEnvVariable {
  /** Concise description of the environment fact represented by the variable. */
  description: string
}

/**
 * A plugin contribution to the managed environment of each model shell call.
 * Declared keys make ownership conflicts detectable before the first command;
 * `resolve` computes only the values available for the current execution.
 */
export interface BashEnvContributor {
  /** Stable contributor name used in diagnostics and duplicate detection. */
  name: string
  /** Complete set of `DSH_*` keys this contributor may return. */
  variables: Readonly<Record<DshEnvironmentKey, BashEnvVariable>>
  /**
   * Resolve this contributor's available values for one tool execution.
   * @param execution - the shell tool execution and its optional calling agent.
   * @returns a partial map containing only keys declared in {@link variables}.
   */
  resolve(execution: ToolExecution): Readonly<Partial<Record<DshEnvironmentKey, string>>>
}

/** An enumerable declaration returned by {@link ShellEnvRegistry.list}. */
export interface BashEnvVariableInfo extends BashEnvVariable {
  /** Contributor that owns the variable. */
  contributor: string
  /** Declared `DSH_*` environment variable name. */
  key: DshEnvironmentKey
}

const DSH_SHELL_KEY = `${DSH_ENV_PREFIX}SHELL` as const
const DSH_SESSION_ID_KEY = `${DSH_ENV_PREFIX}SESSION_ID` as const
const DSH_SESSION_JSONL_KEY = `${DSH_ENV_PREFIX}SESSION_JSONL` as const
const RESERVED_BASH_ENV_KEYS = new Set<DshEnvironmentKey>([
  DSH_HOME_ENV,
  DSH_SHELL_KEY,
  DSH_SESSION_ID_KEY,
])
const BASH_ENV_KEY_SUFFIX = /^[A-Z][A-Z0-9_]*$/

/** The facts one managed `DSH_*` snapshot is composed from. */
export interface DshEnvironmentFacts {
  /** Absolute DeepSeek Harness home, exposed as `DSH_HOME`. */
  dshHome: string
  /**
   * Session this process belongs to, exposed as `DSH_SESSION_ID`. Absent when
   * the caller holds no authoritative session, which omits the variable rather
   * than substituting a value.
   */
  sessionId?: string
}

/**
 * Compose the built-in part of the managed `DSH_*` group from explicit facts.
 *
 * This function is the only place the built-in keys are named, so every entry
 * point into a tenant sandbox injects one group instead of its own subset: the
 * model shell tools through {@link ShellEnvRegistry.collect} and a program the
 * container code runtime starts through
 * {@link ShellEnvRegistry.collectSession}.
 * @param facts - the home and session this process belongs to.
 * @returns a frozen snapshot sorted by variable name.
 */
export function composeDshEnvironment(facts: DshEnvironmentFacts): DshEnvironment {
  const values: Record<DshEnvironmentKey, string> = {
    [DSH_HOME_ENV]: facts.dshHome,
    [DSH_SHELL_KEY]: '1',
  }
  if (facts.sessionId !== undefined) values[DSH_SESSION_ID_KEY] = facts.sessionId
  return sortedSnapshot(values)
}

/** Freeze one overlay in the name-sorted order every collected snapshot is presented in. */
function sortedSnapshot(values: Record<DshEnvironmentKey, string>): DshEnvironment {
  return Object.freeze(Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right))))
}

/**
 * Registry (`ctx.shellEnv`) for trusted, per-execution `DSH_*` variables.
 * The namespace is rebuilt for every model shell call: ambient `DSH_*` values
 * are discarded by the executor, then the registry's current snapshot is
 * injected. Built-in shell facts remain owned by the registry itself while
 * plugins can register additional, enumerable facts with effect-scoped
 * disposal.
 */
export class ShellEnvRegistry extends Service {
  private readonly contributors = new Map<string, BashEnvContributor>()
  private readonly keyOwners = new Map<DshEnvironmentKey, string>()
  private readonly dshHome: string

  /**
   * Create and install the `ctx.shellEnv` service.
   * @param ctx - Cordis context that owns the service and registrations.
   * @param config - home-directory configuration for the built-in variables.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'shellEnv')
    this.dshHome = resolveDshHome(config.dshHome)
  }

  /**
   * Register one environment contributor. Names and keys are unique; built-in
   * keys are reserved. Registration is disposed with the calling plugin fiber.
   * @param contributor - declared key ownership and per-execution resolver.
   * @returns the disposer that unregisters the contribution.
   */
  register(contributor: BashEnvContributor): () => void {
    const dispose = this.ctx.effect(function* (this: ShellEnvRegistry) {
      if (contributor.name.trim().length === 0) {
        throw new Error('bash env contributor name must be non-empty')
      }
      if (this.contributors.has(contributor.name)) {
        throw new Error(`bash env contributor "${contributor.name}" is already registered`)
      }

      const variables = Object.entries(contributor.variables) as [DshEnvironmentKey, BashEnvVariable][]
      for (const [key, variable] of variables) {
        if (!key.startsWith(DSH_ENV_PREFIX)
          || !BASH_ENV_KEY_SUFFIX.test(key.slice(DSH_ENV_PREFIX.length))) {
          throw new Error(`bash env contributor "${contributor.name}" declared invalid key "${key}"`)
        }
        if (RESERVED_BASH_ENV_KEYS.has(key)) {
          throw new Error(`bash env contributor "${contributor.name}" cannot own reserved key "${key}"`)
        }
        if (variable.description.trim().length === 0) {
          throw new Error(`bash env contributor "${contributor.name}" must describe "${key}"`)
        }
        const owner = this.keyOwners.get(key)
        if (owner !== undefined) {
          throw new Error(`bash env key "${key}" is already owned by contributor "${owner}"; contributor "${contributor.name}" cannot also own it`)
        }
      }

      this.contributors.set(contributor.name, contributor)
      for (const [key] of variables) this.keyOwners.set(key, contributor.name)
      yield () => {
        this.contributors.delete(contributor.name)
        for (const [key] of variables) this.keyOwners.delete(key)
      }
    }.bind(this), 'bashEnv.register()')
    return () => void dispose()
  }

  /**
   * Build the trusted `DSH_*` snapshot for one shell tool execution.
   * @param execution - the current tool execution.
   * @returns an immutable environment overlay containing built-ins and current contributions.
   */
  collect(execution: ToolExecution): DshEnvironment {
    const values: Record<DshEnvironmentKey, string> = {
      ...composeDshEnvironment({
        dshHome: this.dshHome,
        ...execution.agent !== undefined ? { sessionId: execution.agent.session.header.id } : {},
      }),
    }

    for (const contributor of [...this.contributors.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      const resolved = contributor.resolve(execution)
      for (const [rawKey, value] of Object.entries(resolved)) {
        const key = rawKey as DshEnvironmentKey
        if (!Object.hasOwn(contributor.variables, key)) {
          throw new Error(`bash env contributor "${contributor.name}" returned undeclared key "${key}"`)
        }
        if (typeof value !== 'string') {
          throw new Error(`bash env contributor "${contributor.name}" returned a non-string value for "${key}"`)
        }
        values[key] = value
      }
    }

    return sortedSnapshot(values)
  }

  /**
   * Build the trusted `DSH_*` snapshot for one harness process started outside
   * the model shell path — the container code runtime, which runs a `run_code`
   * program in the tenant sandbox — so both entry points into that sandbox
   * inject the group {@link composeDshEnvironment} owns instead of two subsets.
   *
   * Built-ins only: a {@link BashEnvContributor} resolves from a
   * {@link ToolExecution}, which this path has none of, so contributor-owned
   * variables (`DSH_SESSION_JSONL`) stay absent here.
   *
   * The session comes from the ambient agent-initiator scope — the authority
   * the agent loop establishes for the current driver chain — never from the
   * process environment. Outside that boundary, or once the agent service is
   * disposed, the variable is absent rather than guessed.
   * @returns an immutable environment overlay containing the built-ins.
   */
  collectSession(): DshEnvironment {
    const sessionId = this.ambientSessionId()
    return composeDshEnvironment(
      sessionId === undefined ? { dshHome: this.dshHome } : { dshHome: this.dshHome, sessionId },
    )
  }

  /** The ambient initiator's session id, or `undefined` without a live authority to read it from. */
  private ambientSessionId(): string | undefined {
    const agents = this.ctx.get('agents')
    if (agents === undefined) return undefined
    try {
      return agents.currentInitiator()?.session.header.id
    } catch {
      // A disposed agent registry rejects every ambient read. A missing
      // environment fact must not fail the caller's run, and `DSH_SESSION_ID`
      // stays absent exactly as it is outside any initiator boundary.
      return undefined
    }
  }

  // TODO(bash-env-list-builtins): Include registry-owned built-ins before diagnostics,
  // prompt, or UI code treats list() as an exhaustive environment catalog.
  /**
   * Enumerate plugin-contributed variables without executing their resolvers.
   * @returns declarations sorted by environment variable name.
   */
  list(): BashEnvVariableInfo[] {
    return [...this.contributors.values()]
      .flatMap(contributor => Object.entries(contributor.variables).map(([key, variable]) => ({
        contributor: contributor.name,
        description: variable.description,
        key: key as DshEnvironmentKey,
      })))
      .sort((left, right) => left.key.localeCompare(right.key))
  }
}

/**
 * Load the shell-env plugin: register the `ctx.shellEnv` service and the
 * shell-agnostic persistence contributor (`DSH_SESSION_JSONL`).
 * @param ctx - Cordis context that owns the service and registrations.
 * @param config - home-directory configuration for the built-in variables.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const registry = new ShellEnvRegistry(ctx, config)
  registry.register({
    name: 'session-persistence',
    variables: {
      [DSH_SESSION_JSONL_KEY]: {
        description: 'Absolute target path of the current session JSONL when the active persistence backend provides one.',
      },
    },
    resolve(execution) {
      const agent = execution.agent
      if (agent === undefined) return {}
      const location = ctx.get('sessionPersistence')?.locate(agent.session.header)
      return location?.kind === 'jsonl' ? { [DSH_SESSION_JSONL_KEY]: location.path } : {}
    },
  })
}
