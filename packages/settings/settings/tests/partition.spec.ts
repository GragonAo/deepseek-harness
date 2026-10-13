/**
 * Partition-keying of the base Service Definition: the in-memory raw-document
 * snapshot is keyed by the ambient partition's tenant id (empty key = no
 * partition), so a read in one partition never surfaces a sibling tenant's
 * section and the resolved values re-source from the ambient partition's
 * document when it changes. A partition-scoped in-memory provider drives this
 * without any file.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { currentPartition, type PartitionScope, type RequestPartition } from '@deepseek-ai/dsh-partition-scope'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '../src/index.ts'

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

/** One ambient partition; the settings base reads only the raw tenant id. */
function partition(tenant: string): RequestPartition {
  return { tenant, tenantName: `tenant_${tenant}`, dataRoot: `/data/${tenant}` }
}

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

/** Partition-scoped in-memory provider: one document per tenant id, empty elsewhere. */
class PartitionMemorySettings extends SettingsProvider {
  private readonly docs = new Map<string, Record<string, unknown>>()

  override get tenantScoped(): boolean {
    return true
  }

  get writable(): boolean {
    return true
  }

  private key(): string {
    return currentPartition(this.ctx)?.tenant ?? ''
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

describe('partition-keyed in-memory snapshot', () => {
  it('isolates tenants and falls back to the global document outside any partition', async () => {
    const ctx = new Context()
    const scope = new TestPartitionScope(ctx, undefined)
    const fiber = ctx.plugin(PartitionMemorySettings)
    await fiber
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await scope.run(partition('acme'), () => ctx.settings.update(ns, { theme: 'light' }))
    // Tenant B resolves its own (still empty) document, not Acme's section.
    await scope.run(partition('globex'), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })
    })
    // Back in Acme's partition, its own value is still there.
    await scope.run(partition('acme'), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
    // Outside any partition, the global document was never written.
    expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })

    await fiber.dispose()
  })
})
