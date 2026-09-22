import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TenantRegistry, {
  TenantId,
  UserId,
  currentScopes,
  currentTenant,
  currentUser,
  isTenantMember,
  requireScope,
  requireTenant,
  requireUser,
  runWithScopes,
  runWithTenant,
  runWithUser,
  tenantPartitionName,
  userPartitionName,
} from '../src/index.ts'
import type { Tenant } from '../src/index.ts'

function tenant(id: string, overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/data/${id}/workspace`,
    ...overrides,
  }
}

describe('tenant authority', () => {
  it('fails closed outside a run', () => {
    expect(currentTenant()).toBeUndefined()
    expect(() => requireTenant()).toThrowMatchingObject({ code: 'NO_TENANT_IN_SCOPE' })
  })

  it('exposes the entered tenant across an async boundary, then clears', async () => {
    const t = tenant('acme')
    expect(currentTenant()).toBeUndefined()
    await runWithTenant(t, async () => {
      expect(currentTenant()).toBe(t)
      expect(requireTenant().id).toBe(t.id)
      await Promise.resolve()
      expect(requireTenant().id).toBe(t.id)
    })
    expect(currentTenant()).toBeUndefined()
  })

  it('shadows and restores the outer tenant on nested runs', () => {
    const outer = tenant('outer')
    const inner = tenant('inner')
    runWithTenant(outer, () => {
      runWithTenant(inner, () => {
        expect(requireTenant().id).toBe(inner.id)
      })
      expect(requireTenant().id).toBe(outer.id)
    })
  })
})

describe('user authority', () => {
  it('fails closed outside a run', () => {
    expect(currentUser()).toBeUndefined()
    expect(() => requireUser()).toThrowMatchingObject({ code: 'NO_USER_IN_SCOPE' })
  })

  it('exposes the entered user across an async boundary, then clears', async () => {
    const user = UserId('user-1')
    expect(currentUser()).toBeUndefined()
    await runWithUser(user, async () => {
      expect(currentUser()).toBe(user)
      expect(requireUser()).toBe(user)
      await Promise.resolve()
      expect(requireUser()).toBe(user)
    })
    expect(currentUser()).toBeUndefined()
  })

  it('shadows and restores the outer user on nested runs', () => {
    const outer = UserId('user-1')
    const inner = UserId('user-2')
    runWithUser(outer, () => {
      runWithUser(inner, () => {
        expect(requireUser()).toBe(inner)
      })
      expect(requireUser()).toBe(outer)
    })
  })

  it('layers independently of the tenant authority', () => {
    const t = tenant('acme')
    const user = UserId('user-1')
    runWithTenant(t, () => {
      expect(currentUser()).toBeUndefined()
      runWithUser(user, () => {
        expect(requireTenant().id).toBe(t.id)
        expect(requireUser()).toBe(user)
      })
    })
  })
})

describe('scopes authority', () => {
  it('fails closed outside a run', () => {
    expect(currentScopes()).toBeUndefined()
    expect(() => requireScope('dsh:tenant-admin')).toThrowMatchingObject({ code: 'MISSING_SCOPE' })
  })

  it('exposes the entered scopes across an async boundary, then clears', async () => {
    expect(currentScopes()).toBeUndefined()
    await runWithScopes(['read', 'dsh:tenant-admin'], async () => {
      expect(currentScopes()).toEqual(['read', 'dsh:tenant-admin'])
      expect(requireScope('dsh:tenant-admin')).toEqual(['read', 'dsh:tenant-admin'])
      await Promise.resolve()
      expect(requireScope('dsh:tenant-admin')).toEqual(['read', 'dsh:tenant-admin'])
    })
    expect(currentScopes()).toBeUndefined()
  })

  it('admits an explicit undefined scope run, still rejecting requirement', () => {
    runWithScopes(undefined, () => {
      expect(currentScopes()).toBeUndefined()
      expect(() => requireScope('dsh:tenant-admin')).toThrowMatchingObject({ code: 'MISSING_SCOPE' })
    })
  })
})

describe('isTenantMember', () => {
  it('treats an absent or empty members list as open', () => {
    expect(isTenantMember(tenant('acme'), UserId('anyone'))).toBe(true)
    expect(isTenantMember(tenant('acme', { members: [] }), UserId('anyone'))).toBe(true)
  })

  it('admits only listed subjects when members are listed', () => {
    const t = tenant('acme', { members: ['alice', 'bob'] })
    expect(isTenantMember(t, UserId('alice'))).toBe(true)
    expect(isTenantMember(t, UserId('bob'))).toBe(true)
    expect(isTenantMember(t, UserId('eve'))).toBe(false)
  })
})

describe('tenantPartitionName', () => {
  it('derives a deterministic, safe, unique scheme from the id', () => {
    const a = tenantPartitionName(TenantId('acme'))
    const b = tenantPartitionName(TenantId('acme'))
    const other = tenantPartitionName(TenantId('acme//corp'))
    expect(a).toBe(b)
    expect(a).toMatch(/^tenant_[a-z0-9_]{1,40}_[0-9a-f]{12}$/u)
    expect(a.length).toBeLessThanOrEqual(63)
    expect(other).not.toBe(a)
  })
})

describe('userPartitionName', () => {
  it('derives a deterministic, safe, unique name from the subject', () => {
    const a = userPartitionName(UserId('user-1'))
    const b = userPartitionName(UserId('user-1'))
    const other = userPartitionName(UserId('user-2'))
    expect(a).toBe(b)
    expect(a).toMatch(/^user_[a-z0-9_]{1,40}_[0-9a-f]{12}$/u)
    expect(a.length).toBeLessThanOrEqual(63)
    expect(other).not.toBe(a)
  })
})

describe('TenantRegistry', () => {
  it('registers, resolves, lists, and disposes records', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    const t = tenant('acme')
    const dispose = ctx.tenants.register(t)
    expect(ctx.tenants.get(t.id)).toBe(t)
    expect(ctx.tenants.resolve(t.id)).toBe(t)
    expect(ctx.tenants.list()).toEqual([t])
    dispose()
    expect(ctx.tenants.get(t.id)).toBeUndefined()
    expect(() => ctx.tenants.resolve(t.id)).toThrowMatchingObject({ code: 'TENANT_UNKNOWN' })
  })

  it('resolves members and rejects non-members fail-closed', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme', { members: ['alice'] }))
    expect(ctx.tenants.resolveMember(TenantId('acme'), UserId('alice')).id).toBe(TenantId('acme'))
    expect(() => ctx.tenants.resolveMember(TenantId('acme'), UserId('eve'))).toThrowMatchingObject({ code: 'NOT_A_MEMBER' })
  })

  it('treats a memberless tenant as open through resolveMember', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    expect(ctx.tenants.resolveMember(TenantId('acme'), UserId('anyone'))).toBeDefined()
  })

  it('rejects duplicate ids and resolves disabled tenants fail-closed', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    expect(() => ctx.tenants.register(tenant('acme'))).toThrowMatchingObject({ code: 'DUPLICATE_TENANT' })

    const disabled = tenant('off', { enabled: false })
    ctx.tenants.register(disabled)
    expect(ctx.tenants.get(disabled.id)).toBe(disabled)
    expect(() => ctx.tenants.resolve(disabled.id)).toThrowMatchingObject({ code: 'TENANT_DISABLED' })
  })

  it('updates a record in place and restores it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    const original = tenant('acme', { name: 'Acme' })
    ctx.tenants.register(original)
    const renamed = tenant('acme', { name: 'Acme Renamed', members: ['alice'] })
    const dispose = ctx.tenants.update(renamed)
    expect(ctx.tenants.get(renamed.id)).toBe(renamed)
    expect(ctx.tenants.resolve(TenantId('acme')).name).toBe('Acme Renamed')
    dispose()
    expect(ctx.tenants.get(renamed.id)).toBe(original)
  })

  it('rejects an update for an unknown id', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    expect(() => ctx.tenants.update(tenant('missing'))).toThrowMatchingObject({ code: 'TENANT_UNKNOWN' })
  })

  it('removes a record and re-registers it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    ctx.tenants.register(tenant('acme'))
    const dispose = ctx.tenants.remove(TenantId('acme'))
    expect(ctx.tenants.get(TenantId('acme'))).toBeUndefined()
    dispose()
    expect(ctx.tenants.resolve(TenantId('acme')).id).toBe(TenantId('acme'))
  })

  it('rejects a remove for an unknown id', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry)
    expect(() => ctx.tenants.remove(TenantId('missing'))).toThrowMatchingObject({ code: 'TENANT_UNKNOWN' })
  })

  it('registers config tenants (branding the wire id) and disposes them on teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantRegistry, {
      tenants: [{
        id: 'acme',
        name: 'Acme',
        dataRoot: '/data/acme',
        workspaceRoot: '/data/acme/workspace',
        toolsRoot: '/tools/acme',
        network: 'internal',
        members: ['alice', 'bob'],
      }, {
        id: 'off',
        name: 'Off',
        dataRoot: '/data/off',
        workspaceRoot: '/data/off/workspace',
        enabled: false,
      }],
    })
    expect(ctx.tenants.resolve(TenantId('acme'))).toMatchObject({
      name: 'Acme',
      dataRoot: '/data/acme',
      toolsRoot: '/tools/acme',
      network: 'internal',
      members: ['alice', 'bob'],
    })
    expect(ctx.tenants.get(TenantId('acme'))).toBeDefined()
    expect(() => ctx.tenants.resolve(TenantId('off'))).toThrowMatchingObject({ code: 'TENANT_DISABLED' })
    const registry = ctx.tenants
    await ctx.fiber.dispose()
    expect(registry.get(TenantId('acme'))).toBeUndefined()
  })

  it('fails loud when config carries a duplicate tenant id', async () => {
    const ctx = new Context()
    let caught: unknown
    try {
      await ctx.plugin(TenantRegistry, {
        tenants: [
          { id: 'acme', name: 'A', dataRoot: '/data/a', workspaceRoot: '/data/a/workspace' },
          { id: 'acme', name: 'B', dataRoot: '/data/b', workspaceRoot: '/data/b/workspace' },
        ],
      })
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: unknown } | undefined)?.code).toBe('DUPLICATE_TENANT')
  })
})

expect.extend({
  toThrowMatchingObject(received: () => unknown, expected: object) {
    try {
      received()
    } catch (error) {
      const pass = Object.entries(expected).every(
        entry => (error as Record<string, unknown>)[entry[0]] === entry[1],
      )
      return { pass, message: () => `expected thrown error to match ${JSON.stringify(expected)}, got ${String(error)}` }
    }
    return { pass: false, message: () => 'expected function to throw' }
  },
})

declare module 'vitest' {
  interface Assertion<T> {
    toThrowMatchingObject(expected: object): T
  }
}
