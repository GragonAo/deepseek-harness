/**
 * The multi-tenant bundle's substance is its patch file. This test post-composes
 * it over dsh-base + dsh-web-app (the same `applyEntryPatches` call the boot
 * include makes) and asserts the provider swap leaves no skipped or mismatched
 * patch: the thirteen single-user rows are disabled, the nineteen tenant rows
 * mount with the names their packages export, the tenant Postgres KV backend
 * replaces the single-user JSON medium and the file settings/credentials
 * providers, code and workflow execution swap the host worker-threads for the
 * tenant container, the workflow/ralph tools are re-enabled, the skill, tool,
 * and config tier providers mount their ambient directories, and
 * sandbox-policy/approval are pinned to the container-admissible modes.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** A composed loader row, narrowed to the fields this test asserts on. */
interface Row {
  id?: string
  name?: string
  group?: boolean | null
  disabled?: boolean | { __jsExpr: string } | null
  config?: Record<string, unknown>
}

/** Read one bundle's manifest patch field. */
function manifestPatch(bundleDir: string): string {
  const manifest = JSON.parse(readFileSync(resolve(bundleDir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) throw new Error(`${bundleDir}/package.json must declare dsh.bundle.patch`)
  return patch
}

/** Parse one bundle patch file as a patch list. */
function loadPatch(bundleDir: string): PatchOptions[] {
  const parsed = yaml.load(
    readFileSync(resolve(bundleDir, manifestPatch(bundleDir)), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError(`${bundleDir}/cordis.patch.yml must parse to a list`)
  return parsed as PatchOptions[]
}

const BUNDLE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = resolve(BUNDLE_ROOT, '../base')
const WEB_APP = resolve(BUNDLE_ROOT, '../web-app')

/** Compose base + web-app + this bundle and return rows by id, plus any warn. */
function compose(): { rows: Map<string, Row>; warns: string[] } {
  const layers = [...loadPatch(BASE), ...loadPatch(WEB_APP), ...loadPatch(BUNDLE_ROOT)]
  const warns: string[] = []
  const composed = applyEntryPatches([], layers, (message: string, ...args: unknown[]) => {
    warns.push(message.replace(/%C/gu, () => JSON.stringify(args.shift())))
  }) as Row[]
  const rows = new Map<string, Row>()
  for (const row of composed) {
    if (row.id !== undefined) rows.set(row.id, row)
  }
  return { rows, warns }
}

describe('dsh-multi-tenant bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    expect(manifestPatch(BUNDLE_ROOT)).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(BUNDLE_ROOT, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('composes over base + web-app with no skipped or name-mismatched patch', () => {
    const { warns } = compose()
    expect(warns).toEqual([])
  })

  it('disables the thirteen single-user rows it replaces', () => {
    const { rows } = compose()
    for (const id of ['session-persistence-jsonl', 'storage-json', 'settings', 'credentials', 'code-runtime', 'subprocess', 'fs-sandbox', 'bash-sandbox', 'sandbox', 'permission', 'connection', 'message-feedback', 'session-projection-cache']) {
      expect(rows.get(id)?.disabled, `${id} disabled`).toBe(true)
    }
  })

  it('mounts the tenant container execution world and carrier with the exported package names', () => {
    const { rows } = compose()
    const expected = new Map<string, string>([
      ['container-runtime', '@deepseek-ai/dsh-container-docker'],
      ['subprocess-container', '@deepseek-ai/dsh-subprocess-container'],
      ['bash-local', '@deepseek-ai/dsh-bash-local'],
      ['fs-container', '@deepseek-ai/dsh-fs-container'],
      ['code-runtime-container', '@deepseek-ai/dsh-code-runtime-container'],
      ['workflow-container', '@deepseek-ai/dsh-workflow-container'],
      ['session-persistence-postgres', '@deepseek-ai/dsh-session-persistence-postgres'],
      ['storage-postgres', '@deepseek-ai/dsh-storage-postgres'],
      ['tenant-admin-postgres', '@deepseek-ai/dsh-tenant-admin-postgres'],
      ['settings-postgres', '@deepseek-ai/dsh-settings-postgres'],
      ['credentials-postgres', '@deepseek-ai/dsh-credentials-postgres'],
      ['tenant', '@deepseek-ai/dsh-tenant'],
      ['tenant-admin', '@deepseek-ai/dsh-tenant-admin'],
      ['tenant-auth-jwt', '@deepseek-ai/dsh-tenant-auth-jwt'],
      ['skill-tier', '@deepseek-ai/dsh-skill-tier'],
      ['tools-tier', '@deepseek-ai/dsh-tools-tier'],
      ['tools-manifest', '@deepseek-ai/dsh-tools-manifest'],
      ['settings-tier', '@deepseek-ai/dsh-settings-tier'],
      ['agent-http', '@deepseek-ai/dsh-agent-http'],
    ])
    for (const [id, name] of expected) {
      const row = rows.get(id)
      expect(row, `${id} mounted`).toBeDefined()
      expect(row?.name, `${id} name`).toBe(name)
      expect(row?.disabled ?? false, `${id} not disabled`).toBe(false)
    }
  })

  it('re-points durable storage to the tenant Postgres backend and drops the JSON medium', () => {
    const { rows } = compose()
    expect(rows.get('storage-json')?.disabled, 'storage-json disabled').toBe(true)
    expect(rows.get('storage-postgres')?.name, 'storage-postgres mounted')
      .toBe('@deepseek-ai/dsh-storage-postgres')
    expect(rows.get('storage-domain')?.config).toEqual({ backend: 'postgres' })
  })

  it('pins the container data-plane roots the tenant providers read', () => {
    const { rows } = compose()
    expect(rows.get('fs-container')?.config).toEqual({ root: '/workspace' })
    expect(rows.get('session-persistence-postgres')?.config).toEqual({
      connectionString: { __jsExpr: 'process.env.DSH_POSTGRES_URL' },
    })
    expect(rows.get('storage-postgres')?.config).toEqual({
      connectionString: { __jsExpr: 'process.env.DSH_POSTGRES_URL' },
    })
    expect(rows.get('tenant-admin-postgres')?.config).toEqual({
      connectionString: { __jsExpr: 'process.env.DSH_POSTGRES_URL' },
    })
    expect(rows.get('tenant-admin')?.config).toEqual({
      adminScope: 'dsh:tenant-admin',
      usersRoot: { __jsExpr: 'process.env.DSH_USERS_ROOT' },
      archiveRoot: { __jsExpr: 'process.env.DSH_ARCHIVE_ROOT' },
    })
    expect(rows.get('tenant')?.config).toBeUndefined()
    expect(rows.get('skill-tier')?.config).toEqual({
      usersRoot: { __jsExpr: 'process.env.DSH_USERS_ROOT' },
    })
    expect(rows.get('tools-tier')?.config).toEqual({
      usersRoot: { __jsExpr: 'process.env.DSH_USERS_ROOT' },
    })
    expect(rows.get('tools-manifest')?.config).toEqual({ defaultCwd: '/workspace' })
    expect(rows.get('settings-tier')?.config).toEqual({
      usersRoot: { __jsExpr: 'process.env.DSH_USERS_ROOT' },
    })
  })

  it('pins the sandbox policy and approval surface to the container-admissible modes', () => {
    const { rows } = compose()
    expect(rows.get('sandbox-policy')?.disabled ?? false).toBe(false)
    expect(rows.get('sandbox-policy')?.config).toEqual({ mode: 'workspace-write' })
    expect(rows.get('approval')?.disabled ?? false).toBe(false)
    expect(rows.get('approval')?.config).toEqual({ policy: 'ask' })
  })

  it('re-enables the workflow and ralph tools over the container workflow engine', () => {
    const { rows } = compose()
    expect(rows.get('tool-workflow')?.disabled ?? false, 'tool-workflow re-enabled').toBe(false)
    expect(rows.get('tool-ralph')?.disabled ?? false, 'tool-ralph re-enabled').toBe(false)
    expect(rows.get('workflow-worker-thread')?.disabled, 'host worker-thread engine off').toBe(true)
  })

  it('presents both native tools and the container run_code tool (env-overridable)', () => {
    const { rows } = compose()
    expect(rows.get('tools')?.config).toEqual({
      mode: { __jsExpr: "process.env.DSH_TOOLS_MODE || 'both'" },
    })
  })
})
