import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applySettingsTier } from '@deepseek-ai/dsh-settings-tier'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import {
  CASE_CONFIG_RANK,
  SESSION_CONFIG_RANK,
  SYSTEM_CONFIG_RANK,
  USER_GLOBAL_CONFIG_RANK,
  settingsNamespace,
  type SettingsTierRoot,
} from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

function tenant(id: string, workspaceRoot = `/workspace/${id}`): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot }
}

function boot(usersRoot?: string, systemConfigDir?: string): Context {
  const ctx = new Context()
  applySettingsTier(ctx, {
    ...(usersRoot === undefined ? {} : { usersRoot }),
    ...(systemConfigDir === undefined ? {} : { systemConfigDir }),
  })
  return ctx
}

function roots(ctx: Context, tenantId?: string, user?: string): readonly SettingsTierRoot[] {
  const read = (): readonly SettingsTierRoot[] => ctx.get('settingsTiers')!.roots()
  if (tenantId === undefined) {
    if (user === undefined) return read()
    return runWithUser(UserId(user), read)
  }
  if (user === undefined) return runWithTenant(tenant(tenantId), read)
  return runWithTenant(tenant(tenantId), () => runWithUser(UserId(user), read))
}

describe('settings-tier ambient tier resolution', () => {
  it('resolves session, case, user-global, and system tiers ranked session > case > user-global > system', async () => {
    const ctx = boot('/users', '/sys/config')
    try {
      expect(roots(ctx, 'acme', 'user-1')).toEqual([
        { kind: 'session', path: join('/workspace/acme', 'config'), rank: SESSION_CONFIG_RANK, trustedHost: true },
        { kind: 'case', path: join('/workspace/acme', 'shared', 'config'), rank: CASE_CONFIG_RANK, trustedHost: true },
        { kind: 'user-global', path: join('/users', 'user-1', 'config'), rank: USER_GLOBAL_CONFIG_RANK, trustedHost: true },
        { kind: 'system', path: resolve('/sys/config'), rank: SYSTEM_CONFIG_RANK, trustedHost: true },
      ])
      expect(SESSION_CONFIG_RANK).toBeLessThan(CASE_CONFIG_RANK)
      expect(CASE_CONFIG_RANK).toBeLessThan(USER_GLOBAL_CONFIG_RANK)
      expect(USER_GLOBAL_CONFIG_RANK).toBeLessThan(SYSTEM_CONFIG_RANK)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits session and case tiers outside a tenant scope', async () => {
    const ctx = boot('/users', '/sys/config')
    try {
      expect(roots(ctx, undefined, 'user-1').map(r => r.kind)).toEqual(['user-global', 'system'])
      expect(roots(ctx, undefined, undefined).map(r => r.kind)).toEqual(['system'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the user-global tier without a user or a usersRoot', async () => {
    const ctx = boot(undefined, '/sys/config')
    try {
      expect(roots(ctx, 'acme', 'user-1').map(r => r.kind)).toEqual(['session', 'case', 'system'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('defaults the system tier under $DSH_HOME and always includes it', async () => {
    const ctx = boot(undefined, undefined)
    try {
      expect(roots(ctx, undefined, undefined)).toEqual([
        { kind: 'system', path: resolve(join(resolveDshHome(), 'system', 'config')), rank: SYSTEM_CONFIG_RANK, trustedHost: true },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('settings-tier per-namespace merge', () => {
  it('deep-merges session > case > user-global > system with nearest-tier wins and union', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-settings-tier-'))
    const ns = settingsNamespace('demo')
    const sysDir = join(base, 'sys')
    const usersRoot = join(base, 'users')
    const workspaceRoot = join(base, 'ws')
    mkdirSync(join(sysDir), { recursive: true })
    mkdirSync(join(usersRoot, 'user-1', 'config'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'shared', 'config'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'config'), { recursive: true })
    writeFileSync(join(sysDir, `${ns}.yaml`), 'a: 1\nb: 2\nnested:\n  x: sys\n  y: sys\n')
    writeFileSync(join(usersRoot, 'user-1', 'config', `${ns}.yaml`), 'b: 20\nc: 30\n')
    writeFileSync(join(workspaceRoot, 'shared', 'config', `${ns}.yaml`), 'd: 40\nnested:\n  y: case\n')
    writeFileSync(join(workspaceRoot, 'config', `${ns}.yaml`), 'e: 50\n')

    const ctx = boot(usersRoot, sysDir)
    try {
      const merged = runWithTenant(tenant('acme', workspaceRoot), () =>
        runWithUser(UserId('user-1'), () => ctx.get('settingsTiers')!.merged(ns)))
      expect(merged).toEqual({ a: 1, b: 20, c: 30, d: 40, e: 50, nested: { x: 'sys', y: 'case' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns an empty document when no per-namespace file exists in any tier', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-settings-tier-empty-'))
    const ctx = boot(join(base, 'users'), join(base, 'sys'))
    try {
      const merged = runWithTenant(tenant('acme', join(base, 'ws')), () =>
        runWithUser(UserId('user-1'), () => ctx.get('settingsTiers')!.merged(settingsNamespace('missing'))))
      expect(merged).toEqual({})
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a per-namespace file that is not a mapping', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-settings-tier-scalar-'))
    const sysDir = join(base, 'sys')
    mkdirSync(sysDir, { recursive: true })
    writeFileSync(join(sysDir, 'demo.yaml'), 'just-a-scalar\n')
    const ctx = boot(join(base, 'users'), sysDir)
    try {
      expect(() => ctx.get('settingsTiers')!.merged(settingsNamespace('demo'))).toThrow(/mapping of setting keys/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
