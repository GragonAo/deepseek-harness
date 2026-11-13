// The `serverName` reservation: one namespace per scope, so a per-user mount can
// shadow a deployment-wide one, while two instances in the same scope collide.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { reserveServerName } from '../src/reservation.ts'

const scopes: Array<() => void> = []

afterEach(() => {
  while (scopes.length > 0) scopes.pop()!()
})

/** Mint a scope under the given context. */
function mint(ctx: Context, name: string): Context {
  const scope = createScope(ctx, { testScope: name })
  scopes.push(() => void scope.rawDispose())
  return scope.ctx
}

describe('reserveServerName', () => {
  it('admits one claim per name and releases it on dispose', () => {
    const ctx = new Context()
    const release = reserveServerName(ctx, 'acme')
    expect(() => reserveServerName(ctx, 'acme')).toThrow(/already in use by another mcp-client instance in the same scope/)
    release()
    expect(() => reserveServerName(ctx, 'acme')).not.toThrow()
  })

  it('admits distinct names in the same scope', () => {
    const ctx = new Context()
    expect(() => {
      reserveServerName(ctx, 'one')
      reserveServerName(ctx, 'two')
    }).not.toThrow()
  })

  it('lets a descendant scope claim a name the outer scope already holds', () => {
    const ctx = new Context()
    reserveServerName(ctx, 'acme')
    const scoped = mint(ctx, 'agent-a')
    expect(() => reserveServerName(scoped, 'acme')).not.toThrow()
  })

  it('lets two sibling scopes each claim the same name', () => {
    const ctx = new Context()
    const first = mint(ctx, 'agent-a')
    const second = mint(ctx, 'agent-b')
    reserveServerName(first, 'acme')
    expect(() => reserveServerName(second, 'acme')).not.toThrow()
  })

  it('still refuses a duplicate inside one scope', () => {
    const ctx = new Context()
    const scoped = mint(ctx, 'agent-a')
    reserveServerName(scoped, 'acme')
    expect(() => reserveServerName(scoped, 'acme')).toThrow(/same scope/)
  })

  it('keeps reservations of two apps apart', () => {
    const first = new Context()
    const second = new Context()
    reserveServerName(first, 'acme')
    expect(() => reserveServerName(second, 'acme')).not.toThrow()
  })
})
