/**
 * Real-composition integration: a per-(tenant,user) in-memory settings
 * provider plus the ambient `settings-tier` carrier and real tier directories
 * proves the full resolution chain — schema defaults, then the composition
 * base, then system/user-global/case/session tiers, then the runtime user
 * document (highest) — over host config files.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import TenantRegistry, { TenantId, currentTenant, currentUser, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant, UserId } from '@deepseek-ai/dsh-tenant'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { apply as applySettingsTier } from '@deepseek-ai/dsh-settings-tier'

function tenant(id: string, workspaceRoot: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot }
}

interface DemoConfig {
  v: string
  w: string
}

const DemoSchema: z<DemoConfig> = z.object({
  v: z.string().default('default-v'),
  w: z.string().default('default-w'),
})

/** Per-(tenant, user) in-memory provider mirroring settings-postgres' scoping. */
class UserMemorySettings extends SettingsProvider {
  private readonly docs = new Map<string, Record<string, unknown>>()

  override get tenantScoped(): boolean {
    return true
  }

  override get userScoped(): boolean {
    return true
  }

  get writable(): boolean {
    return true
  }

  private key(): string {
    const tenant = currentTenant()
    const user = currentUser()
    if (tenant === undefined || user === undefined) return ''
    return `${tenant.id}\u0000${user}`
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.docs.get(this.key()) ?? {}))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    const key = this.key()
    const doc = this.docs.get(key) ?? {}
    doc[ns] = structuredClone(section)
    this.docs.set(key, doc)
    return Promise.resolve()
  }
}

describe('settings-tier real composition', () => {
  it('layers defaults < base < system < user-global < case < session < runtime document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-settings-tier-integration-'))
    const sysDir = join(root, 'sys')
    const usersRoot = join(root, 'users')
    const workspaceRoot = join(root, 'ws')
    mkdirSync(sysDir, { recursive: true })
    mkdirSync(join(usersRoot, 'user-1', 'config'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'shared', 'config'), { recursive: true })
    mkdirSync(join(workspaceRoot, 'config'), { recursive: true })
    writeFileSync(join(sysDir, 'demo.yaml'), 'v: system-v\nw: system-w\n')
    writeFileSync(join(usersRoot, 'user-1', 'config', 'demo.yaml'), 'v: user-v\n')
    writeFileSync(join(workspaceRoot, 'shared', 'config', 'demo.yaml'), 'w: case-w\n')
    writeFileSync(join(workspaceRoot, 'config', 'demo.yaml'), 'v: session-v\n')

    const ctx = new Context()
    // The tenant plugin mounts the ambient partition the settings base keys its
    // snapshot by; without it the partition-keyed seam resolves partitionless.
    const tenantFiber = await ctx.plugin(TenantRegistry)
    const settingsFiber = await ctx.plugin(UserMemorySettings)
    applySettingsTier(ctx, { usersRoot, systemConfigDir: sysDir })
    const ns = settingsNamespace('demo')
    const scope = ctx.settings.register(ns, DemoSchema, { base: { w: 'base-w' } })

    try {
      // Registration runs outside any tenant/user scope: only the system tier layers over base.
      expect(scope.get()).toEqual({ v: 'system-v', w: 'system-w' })

      // Inside the (tenant, user) scope the full disk tiers merge, session > case > user-global > system.
      await runWithTenant(tenant('acme', workspaceRoot), () => runWithUser('user-1' as UserId, () => {
        expect(scope.get()).toEqual({ v: 'session-v', w: 'case-w' })
        // The runtime user document is the highest layer.
        return ctx.settings.update(ns, { v: 'runtime-v' })
      }))
      await runWithTenant(tenant('acme', workspaceRoot), () => runWithUser('user-1' as UserId, () => {
        expect(scope.get()).toEqual({ v: 'runtime-v', w: 'case-w' })
      }))
    } finally {
      await settingsFiber.dispose()
      await tenantFiber.dispose()
    }
  })
})
