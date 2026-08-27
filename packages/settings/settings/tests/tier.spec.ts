/**
 * Tier-layered resolution of the base Service Definition: a `settingsTiers`
 * supplier's per-namespace section layers above the composition `base` and
 * below the per-(tenant, user) user document, so the runtime document stays
 * the highest override. A fixed in-memory tier supplier drives the layering
 * without any host file, keeping this package free of a settings-tier cycle.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TenantId, currentTenant, currentUser, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import type { UserId } from '@deepseek-ai/dsh-tenant'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
  type SettingsTierProvider,
  type SettingsTierRoot,
} from '../src/index.ts'

function tenant(id: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot: `/data/${id}/workspace` }
}

interface DemoConfig {
  label: string
  size: number
}

const DemoSchema: z<DemoConfig> = z.object({
  label: z.string().default('default-label'),
  size: z.number().default(12),
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

/** Fixed per-namespace tier supplier isolating the seam's layering from any file. */
class FixedSettingsTiers extends Service implements SettingsTierProvider {
  constructor(ctx: Context, private readonly sections: ReadonlyMap<SettingsNamespace, Record<string, unknown>>) {
    super(ctx, 'settingsTiers')
  }

  roots(): readonly SettingsTierRoot[] {
    return []
  }

  merged(ns: SettingsNamespace): Record<string, unknown> {
    const section = this.sections.get(ns)
    return section === undefined ? {} : structuredClone(section)
  }
}

async function boot(
  tierSections: ReadonlyMap<SettingsNamespace, Record<string, unknown>>,
): Promise<{ ctx: Context; done: () => Promise<void> }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(UserMemorySettings)
  new FixedSettingsTiers(ctx, tierSections)
  return { ctx, done: async () => fiber.dispose() }
}

describe('settings tier layering', () => {
  it('resolves schema defaults < base < tier < user document', async () => {
    const ns = settingsNamespace('demo')
    const { ctx, done } = await boot(new Map([[ns, { label: 'tier-label' }]]))
    try {
      // No user document yet: the tier section layers over the composition base.
      const scope = ctx.settings.register(ns, DemoSchema, { base: { size: 20 } })
      expect(scope.get()).toEqual({ label: 'tier-label', size: 20 })
      // No base and no tier falls back to schema defaults alone.
      const bare = settingsNamespace('bare')
      expect(ctx.settings.register(bare, DemoSchema).get()).toEqual({ label: 'default-label', size: 12 })
      // The runtime user document layers above the tier section, per (tenant, user) scope.
      await runWithTenant(tenant('acme'), () => runWithUser('user-1' as UserId, async () => {
        await ctx.settings.update(ns, { label: 'user-label' })
        expect(scope.get()).toEqual({ label: 'user-label', size: 20 })
      }))
    } finally {
      await done()
    }
  })

  it('keeps tier and user layers independent: a user reset re-inherits the tier', async () => {
    const ns = settingsNamespace('demo')
    const { ctx, done } = await boot(new Map([[ns, { size: 30 }]]))
    try {
      const scope = ctx.settings.register(ns, DemoSchema)
      expect(scope.get()).toEqual({ label: 'default-label', size: 30 })
      await runWithTenant(tenant('acme'), () => runWithUser('user-1' as UserId, async () => {
        await ctx.settings.update(ns, { label: 'user-label' })
        expect(scope.get()).toEqual({ label: 'user-label', size: 30 })
        await ctx.settings.replace(ns, {})
        expect(scope.get()).toEqual({ label: 'default-label', size: 30 })
      }))
    } finally {
      await done()
    }
  })
})
