/**
 * Tenant-keying of the base Service Definition: the in-memory raw-document
 * snapshot is keyed by the ambient tenant id (empty key = no tenant), so a
 * read in one tenant never surfaces a sibling tenant's section and the
 * resolved values re-source from the ambient tenant's document when the scope
 * changes. A tenant-scoped in-memory provider drives this without any file.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TenantId, currentTenant, runWithTenant } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '../src/index.ts'

function tenant(id: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot: `/data/${id}`, workspaceRoot: `/data/${id}/workspace` }
}

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

/** Tenant-scoped in-memory provider: one document per tenant id, empty elsewhere. */
class TenantMemorySettings extends SettingsProvider {
  private readonly docs = new Map<string, Record<string, unknown>>()

  override get tenantScoped(): boolean {
    return true
  }

  get writable(): boolean {
    return true
  }

  private key(): string {
    return currentTenant()?.id ?? ''
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

describe('tenant-keyed in-memory snapshot', () => {
  it('isolates tenants and falls back to the global document outside any scope', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(TenantMemorySettings)
    await fiber
    const ns = settingsNamespace('ui-theme')
    ctx.settings.register(ns, ThemeSchema)

    await runWithTenant(tenant('acme'), () => ctx.settings.update(ns, { theme: 'light' }))
    // Tenant B resolves its own (still empty) document, not Acme's section.
    await runWithTenant(tenant('globex'), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })
    })
    // Back in Acme's scope, its own value is still there.
    await runWithTenant(tenant('acme'), () => {
      expect(ctx.settings.get(ns)).toEqual({ theme: 'light', fontSize: 14 })
    })
    // Outside any scope, the global document was never written.
    expect(ctx.settings.get(ns)).toEqual({ theme: 'dark', fontSize: 14 })

    await fiber.dispose()
  })
})
