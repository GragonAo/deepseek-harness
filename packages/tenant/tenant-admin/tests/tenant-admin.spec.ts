import { existsSync, promises as fs } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TenantRegistry, { TenantId, runWithScopes } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import TenantAdmin, {
  TENANT_RECORD_STORE,
  TENANT_SCHEMA_LIFECYCLE,
} from '../src/index.ts'
import type { TenantRecordStore, TenantSchemaLifecycle } from '../src/index.ts'

const ADMIN = ['dsh:tenant-admin']

/** Build a `CreateTenantRequest` from a bare id plus overrides. */
function request(id: string, overrides: Partial<{
  name: string
  dataRoot: string
  workspaceRoot: string
  toolsRoot: string
  network: 'none' | 'internal'
  members: string[]
}> = {}): Parameters<TenantAdmin['create']>[0] {
  return {
    id,
    name: overrides.name ?? id,
    dataRoot: overrides.dataRoot ?? `/data/${id}`,
    workspaceRoot: overrides.workspaceRoot ?? `/data/${id}/workspace`,
    ...(overrides.toolsRoot !== undefined ? { toolsRoot: overrides.toolsRoot } : {}),
    ...(overrides.network !== undefined ? { network: overrides.network } : {}),
    ...(overrides.members !== undefined ? { members: overrides.members } : {}),
  }
}

function memoryStore(): TenantRecordStore {
  const records = new Map<string, Tenant>()
  return {
    load: async () => [...records.values()],
    upsert: async (record) => { records.set(String(record.id), record) },
    delete: async (id) => { records.delete(String(id)) },
  }
}

function recordingLifecycle(events: string[]): TenantSchemaLifecycle {
  return {
    provision: async (id) => { events.push(`provision:${String(id)}`) },
    purge: async (id) => { events.push(`purge:${String(id)}`) },
  }
}

async function boot(options: {
  usersRoot?: string
  archiveRoot?: string
  store?: TenantRecordStore
  lifecycle?: TenantSchemaLifecycle
} = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TenantRegistry)
  if (options.store !== undefined) ctx.provide(TENANT_RECORD_STORE, options.store)
  if (options.lifecycle !== undefined) ctx.provide(TENANT_SCHEMA_LIFECYCLE, options.lifecycle)
  await ctx.plugin(TenantAdmin, {
    ...(options.usersRoot !== undefined ? { usersRoot: options.usersRoot } : {}),
    ...(options.archiveRoot !== undefined ? { archiveRoot: options.archiveRoot } : {}),
  })
  return ctx
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tenant-admin-'))
  roots.push(root)
  return root
}

/** Await a promise and return its rejection value, failing the assertion if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

/** An errno-coded filesystem failure, as `fs` reports one. */
function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/**
 * Make one source path report a filesystem failure from `rename`, the syscall a
 * cross-device move fails in. Every other path keeps the real rename.
 * @param source - the path whose rename fails.
 * @param error - the failure it raises.
 * @returns a restore function to call once the assertion is done.
 */
function failRenameOf(source: string, error: NodeJS.ErrnoException): () => void {
  const real = fs.rename
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from) === source) throw error
    await real(from, to)
  })
  return () => { spy.mockRestore() }
}

describe('TenantAdmin', () => {
  it('fails closed without the admin scope', async () => {
    const ctx = await boot()
    expect(() => ctx.tenantAdmin.list()).toThrowMatchingObject({ code: 'MISSING_SCOPE' })
  })

  it('creates a tenant: dirs, partition, registry, and store', async () => {
    const root = await tmpRoot()
    const usersRoot = join(root, 'users')
    const events: string[] = []
    const store = memoryStore()
    const ctx = await boot({ usersRoot, store, lifecycle: recordingLifecycle(events) })
    const record = await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', {
      dataRoot: join(root, 'tenants', 'acme'),
      workspaceRoot: join(root, 'work', 'acme', 'workspace'),
      members: ['user-1'],
    })))
    expect(record.id).toBe(TenantId('acme'))
    expect(ctx.tenants.resolve(TenantId('acme'))).toBe(record)
    expect(events).toEqual(['provision:acme'])
    expect((await store.load()).map(r => String(r.id))).toEqual(['acme'])
    expect(existsSync(join(root, 'tenants', 'acme'))).toBe(true)
    expect(existsSync(join(root, 'work', 'acme', 'workspace', 'shared'))).toBe(true)
    // The case-shared tier directories and the member's case workspace are bind-mount
    // sources of the subject's sandbox, so create provisions them rather than leaving
    // the container runtime to create an empty directory at the mount.
    expect(existsSync(join(root, 'work', 'acme', 'workspace', 'shared', 'skills'))).toBe(true)
    expect(existsSync(join(root, 'work', 'acme', 'workspace', 'shared', 'tools'))).toBe(true)
    expect(existsSync(join(root, 'work', 'acme', 'workspace', 'shared', 'config'))).toBe(true)
    expect(existsSync(join(root, 'work', 'acme', 'workspace', 'users', 'user-1'))).toBe(true)
    expect(existsSync(join(usersRoot, 'user-1', 'tools'))).toBe(true)
    expect(existsSync(join(usersRoot, 'user-1', 'skills'))).toBe(true)
    expect(existsSync(join(usersRoot, 'user-1', 'config'))).toBe(true)
  })

  it('rejects a duplicate id and an unsafe id', async () => {
    const ctx = await boot()
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme')))
    expect(await rejection(runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme'))))).toMatchObject({ code: 'DUPLICATE_TENANT' })
    expect(await rejection(runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('../evil'))))).toMatchObject({ code: 'invalid-input' })
  })

  it('lists and gets records', async () => {
    const ctx = await boot()
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme')))
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('beta')))
    runWithScopes(ADMIN, () => {
      expect(ctx.tenantAdmin.list().map(r => String(r.id))).toEqual(['acme', 'beta'])
      expect(ctx.tenantAdmin.get('beta').name).toBe('beta')
    })
  })

  it('updates metadata but keeps id and dataRoot', async () => {
    const ctx = await boot()
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', { network: 'none' })))
    const next = await runWithScopes(ADMIN, () => ctx.tenantAdmin.update('acme', {
      name: 'Renamed',
      workspaceRoot: '/new/w',
      network: 'internal',
    }))
    expect(next).toMatchObject({ id: TenantId('acme'), name: 'Renamed', dataRoot: '/data/acme', workspaceRoot: '/new/w', network: 'internal' })
  })

  it('disables and re-enables a tenant', async () => {
    const ctx = await boot()
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme')))
    const off = await runWithScopes(ADMIN, () => ctx.tenantAdmin.disable('acme'))
    expect(off.enabled).toBe(false)
    expect(() => ctx.tenants.resolve(TenantId('acme'))).toThrowMatchingObject({ code: 'TENANT_DISABLED' })
    const on = await runWithScopes(ADMIN, () => ctx.tenantAdmin.enable('acme'))
    expect(on.enabled).toBe(true)
    expect(ctx.tenants.resolve(TenantId('acme'))).toBe(on)
  })

  it('removes without purge (record gone, dirs kept); purge archives and drops the partition', async () => {
    const root = await tmpRoot()
    const events: string[] = []
    const ctx = await boot({ archiveRoot: join(root, '.archived'), lifecycle: recordingLifecycle(events) })
    const data = join(root, 'tenants', 'acme')
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', { dataRoot: data, workspaceRoot: join(root, 'work', 'acme', 'workspace') })))
    expect(existsSync(data)).toBe(true)

    await runWithScopes(ADMIN, () => ctx.tenantAdmin.remove('acme', false))
    expect(ctx.tenants.get(TenantId('acme'))).toBeUndefined()
    expect(existsSync(data)).toBe(true)
    expect(events).toEqual(['provision:acme'])

    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('beta', {
      dataRoot: join(root, 'tenants', 'beta'),
      workspaceRoot: join(root, 'work', 'beta', 'workspace'),
    })))
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.remove('beta', true))
    expect(events).toEqual(['provision:acme', 'provision:beta', 'purge:beta'])
    expect(existsSync(join(root, 'tenants', 'beta'))).toBe(false)
    expect(existsSync(join(root, 'work', 'beta', 'workspace'))).toBe(false)
    const archived = await readdir(join(root, '.archived'))
    expect(archived).toHaveLength(1)
    // A purge archives both roots: a workspace left behind keeps occupying the
    // host while the call reports the tenant removed.
    expect((await readdir(join(root, '.archived', archived[0]!))).sort()).toEqual(['data', 'workspace'])
  })

  it('archives a workspace that lives on another filesystem than the archive root', async () => {
    const root = await tmpRoot()
    const archiveRoot = join(root, '.archived')
    const data = join(root, 'data', 'acme')
    const workspace = join(root, 'tenants', 'acme', 'workspace')
    const ctx = await boot({ archiveRoot })
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', {
      dataRoot: data,
      workspaceRoot: workspace,
      members: ['user-1'],
    })))
    await writeFile(join(workspace, 'users', 'user-1', 'case.txt'), 'evidence')

    // The archive root and a tenant's roots are separate bind-mount sources of the
    // containerized deployment, so the move between them is cross-device and
    // rename(2) refuses it with EXDEV. The move degrades to copy-and-delete; the
    // workspace must land in the archive rather than stay where it was.
    const restore = failRenameOf(workspace, errno('EXDEV', `EXDEV: cross-device link not permitted, rename '${workspace}'`))
    try {
      await runWithScopes(ADMIN, () => ctx.tenantAdmin.remove('acme', true))
    } finally {
      restore()
    }

    expect(existsSync(workspace)).toBe(false)
    const [stamp] = await readdir(archiveRoot)
    expect(stamp).toMatch(/^acme-\d+$/)
    expect((await readdir(join(archiveRoot, stamp!))).sort()).toEqual(['data', 'workspace'])
    expect(await readFile(join(archiveRoot, stamp!, 'workspace', 'users', 'user-1', 'case.txt'), 'utf8')).toBe('evidence')
  })

  it('propagates an archive failure instead of reporting the tenant removed', async () => {
    const root = await tmpRoot()
    const data = join(root, 'data', 'acme')
    const ctx = await boot({ archiveRoot: join(root, '.archived') })
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', {
      dataRoot: data,
      workspaceRoot: join(root, 'tenants', 'acme', 'workspace'),
    })))

    const restore = failRenameOf(data, errno('EACCES', `EACCES: permission denied, rename '${data}'`))
    try {
      await expect(runWithScopes(ADMIN, () => ctx.tenantAdmin.remove('acme', true))).rejects.toThrow(/EACCES/)
    } finally {
      restore()
    }

    // The failure is not absorbed: no acknowledgement was returned, and the record
    // and its directories are still there.
    expect(ctx.tenants.get(TenantId('acme'))).toBeDefined()
    expect(existsSync(data)).toBe(true)
  })

  it('purges a tenant whose directory is already gone', async () => {
    const root = await tmpRoot()
    const archiveRoot = join(root, '.archived')
    const data = join(root, 'data', 'acme')
    const workspace = join(root, 'tenants', 'acme', 'workspace')
    const ctx = await boot({ archiveRoot })
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', { dataRoot: data, workspaceRoot: workspace })))
    await rm(workspace, { recursive: true, force: true })

    // A missing directory is the one failure the archive absorbs: there is nothing
    // left to archive for it, and the rest of the purge still runs.
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.remove('acme', true))
    expect(ctx.tenants.get(TenantId('acme'))).toBeUndefined()
    const [stamp] = await readdir(archiveRoot)
    expect(await readdir(join(archiveRoot, stamp!))).toEqual(['data'])
  })

  it('manages members: add bootstraps dirs and dedupes, remove filters, list reads', async () => {
    const root = await tmpRoot()
    const usersRoot = join(root, 'users')
    const ctx = await boot({ usersRoot })
    await runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', {
      dataRoot: join(root, 't', 'acme'),
      workspaceRoot: join(root, 'w', 'acme'),
      members: ['user-1'],
    })))
    await runWithScopes(ADMIN, async () => {
      expect(await ctx.tenantAdmin.membersAdd('acme', 'user-2')).toEqual(['user-1', 'user-2'])
      expect(await ctx.tenantAdmin.membersAdd('acme', 'user-2')).toEqual(['user-1', 'user-2'])
      expect(existsSync(join(usersRoot, 'user-2', 'config'))).toBe(true)
      // The admitted subject's case workspace, which the sandbox mounts at /workspace.
      expect(existsSync(join(root, 'w', 'acme', 'users', 'user-2'))).toBe(true)
      expect(await ctx.tenantAdmin.membersRemove('acme', 'user-1')).toEqual(['user-2'])
      expect(ctx.tenantAdmin.membersList('acme')).toEqual(['user-2'])
    })
  })

  it('users.ensure bootstraps one subject without touching members', async () => {
    const root = await tmpRoot()
    const usersRoot = join(root, 'users')
    const ctx = await boot({ usersRoot })
    const result = await runWithScopes(ADMIN, () => ctx.tenantAdmin.usersEnsure('user-9'))
    expect(result.root).toBe(join(usersRoot, 'user-9'))
    expect(existsSync(join(result.root, 'skills'))).toBe(true)
  })

  it('rejects users.ensure when usersRoot is not configured', async () => {
    const ctx = await boot()
    expect(await rejection(runWithScopes(ADMIN, () => ctx.tenantAdmin.usersEnsure('user-9')))).toMatchObject({ code: 'invalid-input' })
  })

  it('rolls back the registry when the store rejects a create', async () => {
    const root = await tmpRoot()
    const store: TenantRecordStore = {
      load: async () => [],
      upsert: async () => { throw new Error('store down') },
      delete: async () => {},
    }
    const ctx = await boot({ store })
    const attempt = runWithScopes(ADMIN, () => ctx.tenantAdmin.create(request('acme', {
      dataRoot: join(root, 'd', 'acme'),
      workspaceRoot: join(root, 'w', 'acme'),
    })))
    expect(await rejection(attempt)).toMatchObject({ code: 'provision-failed' })
    expect(ctx.tenants.get(TenantId('acme'))).toBeUndefined()
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
