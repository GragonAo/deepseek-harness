/**
 * 单根 `.dsh` 布局：claim 只挂一个根，租户私有根全部收在它下面。
 *
 * 为什么钉死这几条：`claimRoot` 收窄后，任何一个挂载源留在根之外都会让 provider 在加载时
 * 报错，这种错误是响的；而**建目录清单漏掉某一层**只会让容器运行时把缺失的绑定源静默建成
 * 空目录，故障推迟到下游某个会话里才出现。所以这里既钉「每个挂载源都在 claimRoot 之下、
 * 且换算出的 subPath 不逃出 claim」，也钉「那份建目录与出挂载表共用的唯一清单覆盖每一个
 * 挂载源」，并顺手钉住已经消灭的那两棵树不会再回来。
 */
import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tenantDirectories } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { sandboxMounts } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** 单根布局的根：claim 挂载点、也是所有宿主挂载源的共同祖先。 */
const ROOT = '/opt/dsh/.dsh'

/** 技能聚合根：容器本地可写空目录，不是宿主挂载，因此不受单根约束。 */
const SKILLS_ROOT = '/opt/data/skills'

/** 部署与租户在宿主上实际存在的那些根。 */
const LAYOUT = {
  dataRoot: `${ROOT}/tenants/sunce-1028`,
  workspaceRoot: `${ROOT}/tenants/sunce-1028/workspace`,
  toolsRoot: `${ROOT}/tools`,
  usersRoot: `${ROOT}/users`,
  archiveRoot: `${ROOT}/archive`,
  systemRoot: `${ROOT}/system`,
  pythonRoot: `${ROOT}/pyenv`,
  members: ['user_1'],
}

/** 挂载表只看租户的这两项：工作区各层从哪里挂、`/tools` 从哪里挂。 */
const TENANT: Pick<Tenant, 'workspaceRoot' | 'toolsRoot'> = {
  workspaceRoot: LAYOUT.workspaceRoot,
  toolsRoot: LAYOUT.toolsRoot,
}

const SUBJECT = 'user_1'

/** 覆盖项：允许显式传 `undefined`，用来构造「没配 claim」的对照。 */
type ConfigOverrides = { [K in keyof Config]?: Config[K] | undefined }

/** 单根布局下的 provider 配置；`as Config` 承接刻意构造的配置。 */
const config = (overrides: ConfigOverrides = {}): Config => ({
  namespace: 'dsh-v2',
  image: 'dsh-tool-exec:latest',
  kubectlBinary: 'kubectl',
  imagePullPolicy: 'IfNotPresent',
  toolExecPort: 8642,
  usersRoot: LAYOUT.usersRoot,
  systemRoot: LAYOUT.systemRoot,
  toolsRoot: LAYOUT.toolsRoot,
  pythonRoot: LAYOUT.pythonRoot,
  workspaceClaim: 'dsh-workspace-v2',
  claimRoot: ROOT,
  command: ['node', 'entry.mjs'],
  env: {},
  cliTimeoutMs: 300,
  startTimeoutMs: 5_000,
  statusPollMs: 5,
  readyTimeoutMs: 1_000,
  readyPollMs: 5,
  transportTimeoutMs: 5_000,
  sandboxCacheTtlMs: 5_000,
  ...overrides,
}) as Config

/**
 * 目录清单由 `path.join` 生成（Windows 上是反斜杠），挂载源是 POSIX 串；比较前归一。
 * @param value - 宿主路径。
 * @returns 以 `/` 分隔的同一路径。
 */
const posix = (value: string): string => value.split(sep).join('/')

/**
 * 宿主形式的挂载：来源是宿主路径的那批。
 *
 * claim 形式把来源换成了 `subPath`，只剩容器本地那条没有 `source`，按有无 `source` 区分即可。
 * @returns 宿主挂载源，顺序稳定。
 */
function hostSources(): string[] {
  const mounts = sandboxMounts(config({ workspaceClaim: undefined, claimRoot: undefined }), TENANT, SUBJECT)
  return mounts.flatMap(mount => ('source' in mount ? [mount.source] : []))
}

describe('单根 .dsh 布局', () => {
  it('每一个宿主挂载源都投影成 claim 挂载，subPath 不逃出 claim', () => {
    const mounts = sandboxMounts(config(), TENANT, SUBJECT)
    const claims = mounts.filter(mount => mount.kind === 'claim')
    const locals = mounts.filter(mount => mount.kind !== 'claim')
    // 配了几个宿主源就该有几个 claim 挂载：少一个就意味着某层被悄悄漏掉了。
    expect(claims.length).toBe(hostSources().length)
    for (const claim of claims) {
      expect('subPath' in claim ? claim.subPath.startsWith('..') : true).toBe(false)
    }
    // 容器本地那条只允许是技能聚合根，它没有 subPath，也不参与单根投影。
    expect(locals).toEqual([{ kind: 'local', mountPath: SKILLS_ROOT }])
  })

  it('建目录清单覆盖每一个宿主挂载源：漏一层会让运行时静默建空目录', () => {
    const directories = tenantDirectories(LAYOUT).map(posix)
    const sources = hostSources()
    expect(sources.length).toBeGreaterThan(0)
    // 一次列出全部缺失项：门禁的报错要说清「缺哪一层」，而不是只说「有一个缺」。
    expect(sources.filter(source => !directories.includes(source))).toEqual([])
  })

  it('宿主挂载源全部落在单根之下', () => {
    for (const source of hostSources()) expect(source.startsWith(`${ROOT}/`)).toBe(true)
  })

  it('已消灭的两棵树不会再作为挂载源或待建目录回来', () => {
    const gone = (path: string): boolean => path === '/opt/dsh/tenants' || path.startsWith('/opt/dsh/tenants/')
      || path === '/opt/dsh/tools' || path.startsWith('/opt/dsh/tools/')
    for (const source of hostSources()) expect(gone(source)).toBe(false)
    for (const directory of tenantDirectories(LAYOUT).map(posix)) expect(gone(directory)).toBe(false)
  })

  it('挂载源落在 claimRoot 之外时点名报错，而不是产出逃出 claim 的 subPath', () => {
    const narrowed = config({ claimRoot: `${ROOT}/tenants` })
    expect(() => sandboxMounts(narrowed, TENANT, SUBJECT)).toThrow(/outside claimRoot/)
  })
})
