import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantId, UserId } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { decodeSegments, plainSegments, resolveTarget, scopeRoots } from '../src/roots.ts'

function tenant(): Tenant {
  return { id: TenantId('acme'), name: 'acme', dataRoot: '/data/acme', workspaceRoot: '/ws/acme' }
}

/** A deployment root shaped like the one the container providers mount. */
function layout(): { root: string; usersRoot: string; systemRoot: string; workspaceRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fs-http-roots-'))
  const workspaceRoot = join(root, 'ws')
  const usersRoot = join(root, 'users')
  const systemRoot = join(root, 'sys')
  mkdirSync(join(workspaceRoot, 'work'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'users', 'user-1', 'work'), { recursive: true })
  mkdirSync(join(workspaceRoot, 'users', 'user-1', 'sessions', 'session-1'), { recursive: true })
  mkdirSync(join(usersRoot, 'user-1', 'work'), { recursive: true })
  mkdirSync(join(systemRoot, 'skills'), { recursive: true })
  return { root, usersRoot, systemRoot, workspaceRoot }
}

function scoped(workspaceRoot: string, usersRoot?: string, systemRoot?: string) {
  return scopeRoots({
    tenant: { ...tenant(), workspaceRoot },
    subject: UserId('user-1'),
    ...(usersRoot === undefined ? {} : { usersRoot }),
    ...(systemRoot === undefined ? {} : { systemRoot }),
  })
}

describe('file scopes', () => {
  it('maps each scope onto the directory the sandbox mounts, and marks only two writable', () => {
    const roots = scoped('/ws/acme', '/users', '/sys')
    expect(roots.get('session')).toEqual({ scope: 'session', dir: join('/ws/acme', 'users', 'user-1', 'sessions'), writable: true })
    expect(roots.get('user')).toEqual({ scope: 'user', dir: join('/ws/acme', 'users', 'user-1', 'work'), writable: true })
    expect(roots.get('case')).toEqual({ scope: 'case', dir: join('/ws/acme', 'work'), writable: false })
    expect(roots.get('global')).toEqual({ scope: 'global', dir: join('/users', 'user-1', 'work'), writable: false })
    expect(roots.get('system')).toEqual({ scope: 'system', dir: '/sys', writable: false })
  })

  it('leaves a scope out of the table when the deployment does not configure its root', () => {
    const roots = scoped('/ws/acme')
    expect([...roots.keys()]).toEqual(['session', 'user', 'case'])
  })
})

describe('path resolution', () => {
  it('resolves a path inside its own scope root', async () => {
    const layouted = layout()
    const target = await resolveTarget(scoped(layouted.workspaceRoot, layouted.usersRoot, layouted.systemRoot), 'user', ['notes.md'])
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.relative).toBe('notes.md')
    expect(target.hostPath).toBe(join(layouted.workspaceRoot, 'users', 'user-1', 'work', 'notes.md'))
  })

  it('resolves the session scope to one session directory below its root', async () => {
    const layouted = layout()
    const target = await resolveTarget(scoped(layouted.workspaceRoot, layouted.usersRoot, layouted.systemRoot), 'session', ['session-1', 'a.md'])
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.relative).toBe('session-1/a.md')
    expect(target.hostPath).toBe(join(layouted.workspaceRoot, 'users', 'user-1', 'sessions', 'session-1', 'a.md'))
  })

  it('refuses an unknown scope, and an unconfigured one as unavailable rather than empty', async () => {
    const layouted = layout()
    const configured = scoped(layouted.workspaceRoot, layouted.usersRoot, layouted.systemRoot)
    expect(await resolveTarget(configured, 'sessions', ['a'])).toMatchObject({ ok: false, code: 'file-scope-unknown' })
    expect(await resolveTarget(scoped(layouted.workspaceRoot), 'global', ['a'])).toMatchObject({
      ok: false,
      code: 'file-scope-unavailable',
    })
    expect(await resolveTarget(scoped(layouted.workspaceRoot), 'system', ['a'])).toMatchObject({
      ok: false,
      code: 'file-scope-unavailable',
    })
  })

  it('refuses a configured root that is not on disk instead of serving an empty scope', async () => {
    const layouted = layout()
    const roots = scoped(layouted.workspaceRoot, layouted.usersRoot, join(layouted.root, 'absent'))
    expect(await resolveTarget(roots, 'system', ['x'])).toMatchObject({ ok: false, code: 'file-root-missing' })
  })

  it('refuses every segment that could leave the scope’s root', async () => {
    const layouted = layout()
    const roots = scoped(layouted.workspaceRoot, layouted.usersRoot, layouted.systemRoot)
    for (const segments of [['..'], ['.'], ['a/../b'], ['a\\b'], ['a\0b']] as const) {
      const target = await resolveTarget(roots, 'user', segments)
      expect(target, JSON.stringify(segments)).toMatchObject({ ok: false, code: 'file-path-invalid' })
    }
  })

  it('refuses a percent-encoded separator, and reports an undecodable segment apart from it', () => {
    expect(decodeSegments(['..%2Fetc'])).toBeUndefined()
    expect(decodeSegments(['%E0%A4%A'])).toBeUndefined()
    expect(decodeSegments(['a%20b', 'c'])).toEqual(['a b', 'c'])
    expect(plainSegments(['..'])).toBeUndefined()
    expect(plainSegments(['', 'a', ''])).toEqual(['a'])
  })

  it('refuses a symlink that resolves outside the scope root', async () => {
    const layouted = layout()
    const outside = join(layouted.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const link = join(layouted.workspaceRoot, 'users', 'user-1', 'work', 'escape')
    try {
      symlinkSync(outside, link, 'dir')
    } catch {
      // A host that forbids symlink creation cannot express this escape at all, so
      // there is nothing left for this case to check.
      return
    }
    const roots = scoped(layouted.workspaceRoot, layouted.usersRoot, layouted.systemRoot)
    expect(await resolveTarget(roots, 'user', ['escape', 'secret.txt'])).toMatchObject({
      ok: false,
      code: 'file-path-invalid',
    })
  })
})
