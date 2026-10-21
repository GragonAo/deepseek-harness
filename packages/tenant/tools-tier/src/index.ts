/**
 * Ambient multi-tenant tool tier roots.
 *
 * The multi-tenant carrier derives three tool-manifest directories from the
 * current (tenant, user) scope and exposes them through the optional
 * `ctx.toolTiers` service the tool-manifest loader reads: the case-shared
 * directory `<tenant.workspaceRoot>/tools`, the user-global directory
 * `<usersRoot>/<sub>/tools`, and the system directory (default
 * `$DSH_HOME/system/tools`). Lower-rank tiers outrank higher-rank ones, so a
 * case tool overwrites a same-named user-global tool, which overwrites a
 * same-named system tool; distinct names union. All three roots are host paths
 * outside the tenant container, so they are flagged trusted host for host I/O.
 *
 * @module @deepseek-ai/dsh-tools-tier
 */

import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { currentTenant, currentUser } from '@deepseek-ai/dsh-tenant'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  CASE_TOOL_RANK,
  SYSTEM_TOOL_RANK,
  USER_GLOBAL_TOOL_RANK,
  type ToolTierProvider,
  type ToolTierRoot,
} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-tier'

/** Multi-tenant tool tier configuration. */
export interface Config {
  /** Root holding one `<sub>/tools` directory per authenticated user. */
  usersRoot?: string
  /** Read-only system tool-manifest directory shared by every tenant and user. */
  systemToolsDir?: string
}

/** Validate and default the tier configuration. */
export const Config: Schema<Config> = z.object({
  usersRoot: z.string(),
  systemToolsDir: z.string(),
})

interface ResolvedConfig {
  usersRoot: string | undefined
  systemToolsDir: string
}

/**
 * `ctx.toolTiers` service: resolves the ambient tier roots at call time so
 * the manifest loader picks the tiers of the request currently in scope.
 */
class ToolTierService extends Service implements ToolTierProvider {
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx, 'toolTiers')
  }

  /** Resolve the ambient case, user-global, and system roots, nearest tier first. */
  roots(): ToolTierRoot[] {
    const roots: ToolTierRoot[] = []
    const tenant = currentTenant()
    const user = currentUser()
    if (tenant !== undefined) {
      roots.push({
        kind: 'case',
        path: join(tenant.workspaceRoot, 'tools'),
        rank: CASE_TOOL_RANK,
        trustedHost: true,
      })
    }
    if (user !== undefined && this.config.usersRoot !== undefined) {
      roots.push({
        kind: 'user-global',
        path: join(this.config.usersRoot, String(user), 'tools'),
        rank: USER_GLOBAL_TOOL_RANK,
        trustedHost: true,
      })
    }
    roots.push({
      kind: 'system',
      path: this.config.systemToolsDir,
      rank: SYSTEM_TOOL_RANK,
      trustedHost: true,
    })
    return roots
  }
}

/**
 * Register the ambient tool tier service. The service is state-free: it reads
 * the authority scopes on every `roots()` call, so no per-tenant lifecycle is
 * retained.
 * @param ctx - Cordis context to register the service on.
 * @param config - tier directories; `systemToolsDir` defaults under `$DSH_HOME`.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new ToolTierService(ctx, {
    usersRoot: nonEmpty(config.usersRoot),
    systemToolsDir: resolve(config.systemToolsDir ?? join(resolveDshHome(), 'system', 'tools')),
  })
}

/** Keep an empty-string config value out of path joins. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined
}
