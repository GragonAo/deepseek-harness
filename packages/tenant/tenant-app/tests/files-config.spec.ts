import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TenantAppConfig } from '../src/types.ts'
import { loadTenantAppConfig, TenantAppConfigError } from '../src/config.ts'

/** 一份能通过校验的最小租户配置；`files` 段由各用例自己决定加不加。 */
const BASE = `http:
  host: 127.0.0.1
  port: 8788
database:
  connectionString: postgres://u:p@127.0.0.1:5432/db
auth:
  issuer: it
  verify:
    kind: secret
    secret: s
admin:
  scope: dsh:tenant-admin
tenants:
  usersRoot: /tmp/users
  archiveRoot: /tmp/archive
  defaults:
    dataRoot: /tmp/data
    workspaceRoot: /tmp/ws
    network: none
sandbox:
  backend: docker
`

const dirs: string[] = []

/** 把一段 YAML 接到基础配置后面，落到临时文件里加载。 */
function load(tail: string): TenantAppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tenant-config-'))
  dirs.push(dir)
  const path = join(dir, 'tenant.config.yaml')
  writeFileSync(path, BASE + tail)
  return loadTenantAppConfig(path, {})
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('files.writableScopes', () => {
  it('hands the named scopes to the file face', () => {
    const config = load(`files:
  writableScopes: [session, user, global]
`)

    expect(config.files).toEqual({ writableScopes: ['session', 'user', 'global'] })
  })

  it('stays absent when the section is, so the file face keeps its own default', () => {
    expect(load('').files).toBeUndefined()
  })

  it('names a key it does not know instead of ignoring the section', () => {
    expect(() => load(`files:
  scopes: [global]
`)).toThrow(TenantAppConfigError)
  })
})
