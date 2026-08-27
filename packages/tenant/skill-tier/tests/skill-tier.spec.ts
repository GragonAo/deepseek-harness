import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applySkillTier } from '@deepseek-ai/dsh-skill-tier'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { CASE_SKILL_RANK, SYSTEM_SKILL_RANK, USER_GLOBAL_SKILL_RANK, type SkillTierRoot } from '@deepseek-ai/dsh-skill'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

function tenant(id: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot: `/workspace/${id}` }
}

function boot(usersRoot?: string, systemSkillsDir?: string): Context {
  const ctx = new Context()
  applySkillTier(ctx, {
    ...(usersRoot === undefined ? {} : { usersRoot }),
    ...(systemSkillsDir === undefined ? {} : { systemSkillsDir }),
  })
  return ctx
}

function roots(ctx: Context, tenantId?: string, user?: string): readonly SkillTierRoot[] {
  const read = (): readonly SkillTierRoot[] => ctx.get('skillTiers')!.roots()
  if (tenantId === undefined) {
    if (user === undefined) return read()
    return runWithUser(UserId(user), read)
  }
  if (user === undefined) return runWithTenant(tenant(tenantId), read)
  return runWithTenant(tenant(tenantId), () => runWithUser(UserId(user), read))
}

describe('skill-tier ambient tier resolution', () => {
  it('resolves case, user-global, and system tiers ranked case > user-global > system', async () => {
    const ctx = boot('/users', '/sys/skills')
    try {
      expect(roots(ctx, 'acme', 'user-1')).toEqual([
        { kind: 'case', path: join('/workspace/acme', 'shared', 'skills'), rank: CASE_SKILL_RANK, trustedHost: true },
        { kind: 'user-global', path: join('/users', 'user-1', 'skills'), rank: USER_GLOBAL_SKILL_RANK, trustedHost: true },
        { kind: 'system', path: resolve('/sys/skills'), rank: SYSTEM_SKILL_RANK, trustedHost: true },
      ])
      expect(CASE_SKILL_RANK).toBeLessThan(USER_GLOBAL_SKILL_RANK)
      expect(USER_GLOBAL_SKILL_RANK).toBeLessThan(SYSTEM_SKILL_RANK)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the case tier outside a tenant scope', async () => {
    const ctx = boot('/users', '/sys/skills')
    try {
      expect(roots(ctx, undefined, 'user-1').map(r => r.kind)).toEqual(['user-global', 'system'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the user-global tier without a user or a usersRoot', async () => {
    const ctx = boot(undefined, '/sys/skills')
    try {
      expect(roots(ctx, 'acme', 'user-1').map(r => r.kind)).toEqual(['case', 'system'])
      expect(roots(ctx, 'acme', undefined).map(r => r.kind)).toEqual(['case', 'system'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('defaults the system tier under $DSH_HOME and always includes it', async () => {
    const ctx = boot(undefined, undefined)
    try {
      expect(roots(ctx, undefined, undefined)).toEqual([
        { kind: 'system', path: resolve(join(resolveDshHome(), 'system', 'skills')), rank: SYSTEM_SKILL_RANK, trustedHost: true },
      ])
      expect(roots(ctx, 'acme', 'user-1').map(r => r.kind)).toEqual(['case', 'system'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
