/**
 * Ambient multi-tenant configuration tier roots and per-namespace merge.
 *
 * The multi-tenant carrier derives four config directories from the current
 * (tenant, user, session) scope and exposes them through the optional
 * `ctx.settingsTiers` service the settings Service Definition reads: the
 * session directory `<sessionCwd>/config`, the case-shared directory
 * `<tenant.workspaceRoot>/shared/config`, the user-global directory
 * `<usersRoot>/<sub>/config`, and the system directory (default
 * `$DSH_HOME/system/config`). `merged(ns)` reads the per-namespace file
 * (`<ns>.yaml`/`<ns>.yml`/`<ns>.json`) from each tier deepest-first and
 * deep-merges them, so a value in a nearer tier overwrites a same-named value
 * in a farther tier while distinct keys union. The session tier resolves from
 * the initiating agent's `session.header.cwd` when one is ambient and falls
 * back to the tenant workspace root otherwise. Every tier root is a host path
 * outside the tenant container, so it is flagged trusted host for host I/O.
 *
 * @module @deepseek-ai/dsh-settings-tier
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type AgentRegistry from '@deepseek-ai/dsh-agent'
import { currentTenant, currentUser } from '@deepseek-ai/dsh-tenant'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse } from 'yaml'
import {
  CASE_CONFIG_RANK,
  SESSION_CONFIG_RANK,
  SYSTEM_CONFIG_RANK,
  USER_GLOBAL_CONFIG_RANK,
  mergeLayers,
  type SettingsNamespace,
  type SettingsTierProvider,
  type SettingsTierRoot,
} from '@deepseek-ai/dsh-settings'

/** Cordis plugin name. */
export const name = 'settings-tier'

/** Multi-tenant configuration tier configuration. */
export interface Config {
  /** Root holding one `<sub>/config` directory per authenticated user. */
  usersRoot?: string
  /** Read-only system config directory shared by every tenant and user. */
  systemConfigDir?: string
}

/** Validate and default the tier configuration. */
export const Config: Schema<Config> = z.object({
  usersRoot: z.string(),
  systemConfigDir: z.string(),
})

interface ResolvedConfig {
  usersRoot: string | undefined
  systemConfigDir: string
}

/**
 * `ctx.settingsTiers` service: resolves the ambient tier roots and merges
 * per-namespace config files at call time so the settings seam layers the
 * tiers of the request currently in scope.
 */
class SettingsTierService extends Service implements SettingsTierProvider {
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx, 'settingsTiers')
  }

  /** Resolve the ambient session, case, user-global, and system roots, nearest tier first. */
  roots(): SettingsTierRoot[] {
    const roots: SettingsTierRoot[] = []
    const tenant = currentTenant()
    const user = currentUser()
    const session = ambientSessionCwd(this.ctx, tenant?.workspaceRoot)
    if (tenant !== undefined && session !== undefined) {
      roots.push({ kind: 'session', path: join(session, 'config'), rank: SESSION_CONFIG_RANK, trustedHost: true })
    }
    if (tenant !== undefined) {
      roots.push({
        kind: 'case',
        path: join(tenant.workspaceRoot, 'shared', 'config'),
        rank: CASE_CONFIG_RANK,
        trustedHost: true,
      })
    }
    if (user !== undefined && this.config.usersRoot !== undefined) {
      roots.push({
        kind: 'user-global',
        path: join(this.config.usersRoot, String(user), 'config'),
        rank: USER_GLOBAL_CONFIG_RANK,
        trustedHost: true,
      })
    }
    roots.push({ kind: 'system', path: this.config.systemConfigDir, rank: SYSTEM_CONFIG_RANK, trustedHost: true })
    return roots
  }

  /** Read the per-namespace file from each tier deepest-first and deep-merge them. */
  merged(ns: SettingsNamespace): Record<string, unknown> {
    let merged: Record<string, unknown> = {}
    for (const root of [...this.roots()].reverse()) {
      const section = readConfigSection(root.path, ns)
      if (section !== undefined) merged = mergeLayers(merged, section) as Record<string, unknown>
    }
    return merged
  }
}

/**
 * Register the ambient configuration tier service. The service is state-free:
 * it reads the authority scopes on every call, so no per-tenant lifecycle is
 * retained.
 * @param ctx - Cordis context to register the service on.
 * @param config - tier directories; `systemConfigDir` defaults under `$DSH_HOME`.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new SettingsTierService(ctx, {
    usersRoot: nonEmpty(config.usersRoot),
    systemConfigDir: resolve(config.systemConfigDir ?? join(resolveDshHome(), 'system', 'config')),
  })
}

/** Read one namespace's section file from a tier directory, or absent when none exists. */
function readConfigSection(dir: string, ns: SettingsNamespace): Record<string, unknown> | undefined {
  for (const ext of ['yaml', 'yml', 'json']) {
    const file = join(dir, `${String(ns)}.${ext}`)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const parsed: unknown = ext === 'json' ? JSON.parse(text) : parse(text)
    if (!isPlainObject(parsed)) {
      throw new TypeError(`config tier "${file}" must contain a mapping of setting keys`)
    }
    return parsed
  }
  return undefined
}

/** Resolve the initiating agent's session cwd, falling back when none is ambient. */
function ambientSessionCwd(ctx: Context, fallback: string | undefined): string | undefined {
  const agents = ctx.get('agents') as AgentRegistry | undefined
  if (agents === undefined) return fallback
  try {
    return agents.currentInitiator()?.session.header.cwd ?? fallback
  } catch {
    return fallback
  }
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Keep an empty-string config value out of path joins. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined
}
