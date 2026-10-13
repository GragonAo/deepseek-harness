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
import { currentPartition, type PartitionScope, type RequestPartition } from '@deepseek-ai/dsh-partition-scope'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
  type SettingsTierProvider,
  type SettingsTierRoot,
} from '../src/index.ts'

/** Ambient-partition provider a test drives directly, standing in for a tenancy carrier. */
class TestPartitionScope extends Service implements PartitionScope {
  constructor(ctx: Context, private partition: RequestPartition | undefined) {
    super(ctx, 'partitionScope')
  }

  current(): RequestPartition | undefined {
    return this.partition
  }

  /** Enter one partition for the duration of `run`, restoring the previous one. */
  async run<T>(partition: RequestPartition, run: () => T | Promise<T>): Promise<T> {
    const previous = this.partition
    this.partition = partition
    try {
      return await run()
    } finally {
      this.partition = previous
    }
  }
}

/** One ambient partition; the settings base reads only the raw tenant and user ids. */
function partition(tenant: string, user?: string): RequestPartition {
  return {
    tenant,
    tenantName: `tenant_${tenant}`,
    dataRoot: `/data/${tenant}`,
    ...(user === undefined ? {} : { user, userName: `user_${user}` }),
  }
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
    const partition = currentPartition(this.ctx)
    if (partition?.user === undefined) return ''
    return `${partition.tenant}\u0000${partition.user}`
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
): Promise<{ ctx: Context; scope: TestPartitionScope; done: () => Promise<void> }> {
  const ctx = new Context()
  const scope = new TestPartitionScope(ctx, undefined)
  const fiber = await ctx.plugin(UserMemorySettings)
  new FixedSettingsTiers(ctx, tierSections)
  return { ctx, scope, done: async () => fiber.dispose() }
}

describe('settings tier layering', () => {
  it('resolves schema defaults < base < tier < user document', async () => {
    const ns = settingsNamespace('demo')
    const { ctx, scope, done } = await boot(new Map([[ns, { label: 'tier-label' }]]))
    try {
      // No user document yet: the tier section layers over the composition base.
      const registration = ctx.settings.register(ns, DemoSchema, { base: { size: 20 } })
      expect(registration.get()).toEqual({ label: 'tier-label', size: 20 })
      // No base and no tier falls back to schema defaults alone.
      const bare = settingsNamespace('bare')
      expect(ctx.settings.register(bare, DemoSchema).get()).toEqual({ label: 'default-label', size: 12 })
      // The runtime user document layers above the tier section, per (tenant, user) partition.
      await scope.run(partition('acme', 'user-1'), async () => {
        await ctx.settings.update(ns, { label: 'user-label' })
        expect(registration.get()).toEqual({ label: 'user-label', size: 20 })
      })
    } finally {
      await done()
    }
  })

  it('keeps tier and user layers independent: a user reset re-inherits the tier', async () => {
    const ns = settingsNamespace('demo')
    const { ctx, scope, done } = await boot(new Map([[ns, { size: 30 }]]))
    try {
      const registration = ctx.settings.register(ns, DemoSchema)
      expect(registration.get()).toEqual({ label: 'default-label', size: 30 })
      await scope.run(partition('acme', 'user-1'), async () => {
        await ctx.settings.update(ns, { label: 'user-label' })
        expect(registration.get()).toEqual({ label: 'user-label', size: 30 })
        await ctx.settings.replace(ns, {})
        expect(registration.get()).toEqual({ label: 'default-label', size: 30 })
      })
    } finally {
      await done()
    }
  })
})
