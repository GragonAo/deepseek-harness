/**
 * REAL composition: the multi-tenant profile bundle booted through the Loader
 * over the shipped base + web-app layers (the same layer stack `dsh --profile`
 * composes), keyless and headless. The browser-surface rows (no dist, no
 * browser) are disabled; the tenant-facing rows are pinned with test values;
 * every model/external seam (DeepSeek adapter, telemetry, shipped dirs) is
 * hemmed or disabled. The test asserts the five-row swap RESOLVED into concrete
 * services — the one place the Web shell execution world genuinely differs from
 * the hand-built http-parity spine.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { assertEntriesLoaded, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { DockerContainerRuntime } from '@deepseek-ai/dsh-container-docker'
import { ContainerFileSystem } from '@deepseek-ai/dsh-fs-container'
import { ContainerSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-container'
import { TenantId, TenantRegistry } from '@deepseek-ai/dsh-tenant'
import { JwtTenantAuthenticator } from '@deepseek-ai/dsh-tenant-auth-jwt'
// Empty type imports carry the Context merges the assertions read through ctx.get.
import type {} from '@deepseek-ai/dsh-host-webserver'

const REPO_ROOT = process.cwd()
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
const MULTI_TENANT_PATCH = join(REPO_ROOT, 'packages/bundle/multi-tenant/cordis.patch.yml')

/**
 * Browser-surface rows disabled for a headless API backend. `connection` is
 * disabled by the bundle itself; the rest remove the dist server, the browser
 * roster, and their client-bundle-serving node halves so no unbuilt frontend
 * artifact is required.
 */
const DISABLED_BROWSER_ROWS = [
  'web-runtime',
  'client-hmr',
  'modules',
  'client-runtime',
  'cordis-client-runner',
  'locale',
  'ui-theme',
  'ui-layout',
  'ui-renderer',
  'ui-sidebar',
  'ui-settings',
  'ui-settings-general',
  'ui-settings-models',
  'ui-settings-plugin-inventory',
  'ui-conversation',
  'ui-brand-official',
  'ui-attachment',
  'ui-tool',
  'ui-cordis',
  'ui-workflow-run',
  'ui-deliverables',
  'ui-workspace',
  'ui-input-trigger',
  'ui-commands',
  'ui-skill',
  'ui-subagent',
  'ui-reference',
  'ui-jobs',
  'ui-goal',
  'ui-message-feedback',
  'ui-model-selection',
  'ui-permission',
  'ui-agent-preset',
  'ui-settings-plugins',
  'ui-plan',
  'ui-user-questions',
  'ui-trajectory',
]

describe('multi-tenant bundle boot', () => {
  let ctx: Context
  let world: string

  beforeAll(async () => {
    world = await mkdtemp(join(tmpdir(), 'dsh-mt-loader-'))
    // Link the app's dependency closure — which now includes the multi-tenant
    // bundle and therefore every tenant plugin — into profiles/node_modules,
    // the same flat fallback a production `dsh --profile multi-tenant` heals.
    healProfilesModuleFallback(INSTALL_ANCHOR, world)
    const profileDir = join(world, 'profiles', 'mt')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.yml'), '[]\n')

    const base = loadOverlayPatches('mt loader', BASE_PATCH)
    const web = loadOverlayPatches('mt loader', WEB_PATCH)
    const multiTenant = loadOverlayPatches('mt loader', MULTI_TENANT_PATCH)

    const hermetic: PatchOptions[] = [
      // Agent composition resolves nothing at boot; a turn would get no tools.
      { id: 'agent-presets', config: { default: 'standard', roots: [], includeUserRoot: false } },
      // The multi-tenant swap owns the durable backend: pin the shared Postgres
      // URI (the Pool connects lazily, so boot never touches a database) and the
      // auth material the bundle leaves to the environment.
      {
        id: 'session-persistence-postgres',
        config: { connectionString: 'postgres://unused@127.0.0.1:5432/dsh' },
      },
      { id: 'tenant-auth-jwt', config: { issuer: 'mt-test', secret: 'mt-test-secret' } },
      {
        id: 'tenant',
        config: {
          tenants: [{
            id: 'acme',
            name: 'Acme',
            dataRoot: join(world, 'acme'),
            workspaceRoot: join(world, 'acme', 'workspace'),
          }],
        },
      },
      { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
      { id: 'storage-json', config: { root: join(world, 'storages') } },
      {
        id: 'skill-filesystem',
        config: {
          dshHome: join(world, 'skills-home'),
          agentsHome: join(world, 'skills-agents'),
          bundledSkillDir: join(world, 'skills-bundled'),
          watch: false,
        },
      },
      { id: 'agent-instructions', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'settings', config: { dshHome: world } },
      { id: 'credentials', config: { dshHome: world } },
      { id: 'llm-deepseek', disabled: true },
    ]

    const patches: PatchOptions[] = [
      ...base,
      ...web,
      ...multiTenant,
      ...DISABLED_BROWSER_ROWS.map((id): PatchOptions => ({ id, disabled: true })),
      ...hermetic,
    ]

    ctx = new Context()
    ctx.baseUrl = pathToFileURL(profileDir).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    provideCmdline(ctx, {
      args: [],
      exit: (code) => {
        throw new Error(`mt loader: web app requested exit ${String(code)} with no arguments`)
      },
    })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href, patches },
    })
    await ctx.loader.await()
    assertEntriesLoaded(ctx, 'mt loader')
  })

  afterAll(async () => {
    if (ctx !== undefined) await ctx.fiber.dispose()
    if (world !== undefined) await rm(world, { recursive: true, force: true })
  })

  it('disables the single-user local execution world', () => {
    expect(ctx.get('subprocess')).not.toBeUndefined()
    expect(ctx.get('connection')).toBeUndefined()
    expect(ctx.get('sandbox')).toBeUndefined()
    expect(ctx.get('sandboxPolicy')).not.toBeUndefined()
  })

  it('mounts the container execution world in place of the local one', () => {
    // Compare `constructor.name` against the class' static name: the Loader
    // resolves providers from the built lib, a different module instance than
    // the tests' source import, so `toBeInstanceOf` would report a false miss.
    expect(ctx.get('subprocess')?.constructor?.name).toBe(ContainerSubprocessRuntime.name)
    expect(ctx.get('fs')?.constructor?.name).toBe(ContainerFileSystem.name)
    expect(ctx.get('shell')?.constructor?.name).toBe(LocalBashExecutor.name)
    expect(ctx.get('containerRuntime')?.constructor?.name).toBe(DockerContainerRuntime.name)
  })

  it('mounts the tenant persistence and trust fence', () => {
    // The persistence provider's identity is its `name` (asserting
    // `toBeInstanceOf` would collide with its own `inspect` method under
    // chai's custom-inspect display).
    const persistence = ctx.get('sessionPersistence') as { name?: string } | undefined
    expect(persistence?.name).toBe('session-persistence-postgres')
    expect(ctx.get('tenantAuth')?.constructor?.name).toBe(JwtTenantAuthenticator.name)
    expect(ctx.get('tenants')?.constructor?.name).toBe(TenantRegistry.name)
    expect(ctx.get('tenants')?.get(TenantId('acme'))?.id).toBe('acme')
    expect(ctx.get('agentHttp')).not.toBeUndefined()
    expect(ctx.get('apiProxy')).not.toBeUndefined()
  })

  it('binds the HTTP server for the tenant API', () => {
    const port = ctx.get('webServer')?.port
    expect(typeof port).toBe('number')
    expect(port).toBeGreaterThan(0)
  })
})
