/**
 * Ambient multi-tenant skill tier roots.
 *
 * The multi-tenant carrier derives three skill directories from the current
 * (tenant, user) scope and exposes them through the optional `ctx.skillTiers`
 * service the filesystem skill provider reads: the case-shared directory
 * `<tenant.workspaceRoot>/skills`, the user-global directory
 * `<usersRoot>/<sub>/skills`, and the system directory (default
 * `$DSH_HOME/system/skills`). Lower-rank tiers outrank higher-rank ones, so a
 * case skill overwrites a same-named user-global skill, which overwrites a
 * same-named system skill; distinct names union. All three roots are host paths
 * outside the tenant container, so they are flagged trusted-host for host I/O.
 *
 * @module @deepseek-ai/dsh-skill-tier
 */

import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { TENANT_SKILL_DIR_NAME, currentTenant, currentUser } from '@deepseek-ai/dsh-tenant'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  CASE_SKILL_RANK,
  SYSTEM_SKILL_RANK,
  USER_GLOBAL_SKILL_RANK,
  type SkillTierProvider,
  type SkillTierRoot,
} from '@deepseek-ai/dsh-skill'

/** Cordis plugin name. */
export const name = 'skill-tier'

/** Multi-tenant skill tier configuration. */
export interface Config {
  /** Root holding one `<sub>/skills` directory per authenticated user. */
  usersRoot?: string
  /** Read-only system skill directory shared by every tenant and user. */
  systemSkillsDir?: string
}

/** Validate and default the tier configuration. */
export const Config: Schema<Config> = z.object({
  usersRoot: z.string(),
  systemSkillsDir: z.string(),
})

interface ResolvedConfig {
  usersRoot: string | undefined
  systemSkillsDir: string
}

/**
 * `ctx.skillTiers` service: resolves the ambient tier roots at call time so
 * the filesystem provider picks the tiers of the request currently in scope.
 */
class SkillTierService extends Service implements SkillTierProvider {
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx, 'skillTiers')
  }

  /** Resolve the ambient case, user-global, and system roots, nearest tier first. */
  roots(): SkillTierRoot[] {
    const roots: SkillTierRoot[] = []
    const tenant = currentTenant()
    const user = currentUser()
    if (tenant !== undefined) {
      roots.push({
        kind: 'case',
        path: join(tenant.workspaceRoot, TENANT_SKILL_DIR_NAME),
        rank: CASE_SKILL_RANK,
        trustedHost: true,
      })
    }
    if (user !== undefined && this.config.usersRoot !== undefined) {
      roots.push({
        kind: 'user-global',
        path: join(this.config.usersRoot, String(user), 'skills'),
        rank: USER_GLOBAL_SKILL_RANK,
        trustedHost: true,
      })
    }
    roots.push({
      kind: 'system',
      path: this.config.systemSkillsDir,
      rank: SYSTEM_SKILL_RANK,
      trustedHost: true,
    })
    return roots
  }
}

/**
 * Register the ambient skill tier service. The service is state-free: it reads
 * the authority scopes on every `roots()` call, so no per-tenant lifecycle is
 * retained.
 * @param ctx - Cordis context to register the service on.
 * @param config - tier directories; `systemSkillsDir` defaults under `$DSH_HOME`.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new SkillTierService(ctx, {
    usersRoot: nonEmpty(config.usersRoot),
    systemSkillsDir: resolve(config.systemSkillsDir ?? join(resolveDshHome(), 'system', 'skills')),
  })
}

/** Keep an empty-string config value out of path joins. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined
}
