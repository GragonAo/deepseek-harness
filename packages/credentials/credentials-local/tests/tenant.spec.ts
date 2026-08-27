import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TenantId, runWithTenant } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { CREDENTIALS_FILENAME, activeCredentialFilename, LocalCredentialProvider } from '../src/index.ts'

const KEY = credentialRef('DSH_TENANT_TEST')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-tenant-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

/** One tenant record; only `id` and `dataRoot` matter to the credentials layer. */
function tenant(id: string, dataRoot: string): Tenant {
  return { id: TenantId(id), name: id, dataRoot, workspaceRoot: join(dataRoot, 'workspace') }
}

describe('activeCredentialFilename', () => {
  it('resolves <tenant.dataRoot>/.credentials.yaml inside a tenant scope', () => {
    const dir = resolve('/tenants/acme')
    const acme = tenant('acme', dir)
    const filename = runWithTenant(acme, () => activeCredentialFilename({ dshHome: '/home' }))
    expect(filename).toBe(resolve('/tenants/acme/.credentials.yaml'))
  })

  it('falls back to the harness home outside a tenant scope', () => {
    expect(activeCredentialFilename({ dshHome: '/home' })).toBe(resolve('/home/.credentials.yaml'))
  })

  it('keeps an explicit path global, ignoring the ambient tenant', () => {
    const acme = tenant('acme', '/tenants/acme')
    const filename = runWithTenant(acme, () => activeCredentialFilename({ path: '/fixed/creds.yaml' }))
    expect(filename).toBe(resolve('/fixed/creds.yaml'))
  })
})

describe('tenant-scoped credentials', () => {
  it('isolates managed documents between tenants', async () => {
    const root = await tempDir()
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    const ctx = await boot({ dshHome: join(root, 'home'), watch: false })
    const a = tenant('acme', dirA)
    const b = tenant('globex', dirB)

    await runWithTenant(a, () => ctx.credentials.set(KEY, 'sk-a'))
    // Set under A: B reads nothing, A reads it back.
    expect(await runWithTenant(b, () => ctx.credentials.resolve(KEY))).toBeUndefined()
    expect(await runWithTenant(a, () => ctx.credentials.resolve(KEY))).toEqual({ value: 'sk-a', source: 'file' })
    // Each document lives under its own tenant's data root.
    expect(await readFile(join(dirA, CREDENTIALS_FILENAME), 'utf8')).toContain('sk-a')
    await expect(readFile(join(dirB, CREDENTIALS_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to $DSH_HOME/.credentials.yaml outside a tenant scope', async () => {
    const root = await tempDir()
    const home = join(root, 'home')
    const ctx = await boot({ dshHome: home, watch: false })

    await ctx.credentials.set(KEY, 'global-value')
    expect(await readFile(join(home, CREDENTIALS_FILENAME), 'utf8')).toContain('global-value')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'global-value', source: 'file' })
  })

  it('an explicit config.path ignores tenant scoping', async () => {
    const root = await tempDir()
    const fixedPath = join(root, 'fixed.yaml')
    const dirA = join(root, 'a')
    const ctx = await boot({ path: fixedPath, watch: false })
    const a = tenant('acme', dirA)

    await runWithTenant(a, () => ctx.credentials.set(KEY, 'fixed-value'))
    // The write lands in the fixed document, never the tenant's data root.
    expect(await readFile(fixedPath, 'utf8')).toContain('fixed-value')
    await expect(readFile(join(dirA, CREDENTIALS_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await runWithTenant(a, () => ctx.credentials.resolve(KEY))).toEqual({ value: 'fixed-value', source: 'file' })
  })

  it('the inherited environment still wins over the tenant-managed document', async () => {
    const root = await tempDir()
    const dirA = join(root, 'a')
    const ctx = await boot({ dshHome: join(root, 'home'), watch: false })
    const a = tenant('acme', dirA)

    await runWithTenant(a, () => ctx.credentials.set(KEY, 'stored'))
    vi.stubEnv('DSH_TENANT_TEST', 'from-env')
    expect(await runWithTenant(a, () => ctx.credentials.resolve(KEY))).toEqual({ value: 'from-env', source: 'env' })
    expect(await runWithTenant(a, () => ctx.credentials.describe(KEY)))
      .toEqual({ configured: true, source: 'env', writable: false })
  })
})
