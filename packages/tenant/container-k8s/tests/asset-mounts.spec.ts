/**
 * 资产卷：把指定的挂载源改由另一块 claim 承载。
 *
 * 为什么钉死这几条：命中判定按路径精确匹配，打错一个字符就等于没配，而漏配只会在沙箱里表现为
 * 「文件不存在」。所以这里既钉投影结果（claim 与 subPath 换了，挂载点与只读性不变），也钉三种
 * 硬失败：命名了一个不是来源的路径、同一个源写两条、以及没有 claim 却要投影。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ContainerCommandResult, ContainerExecOptions } from '@deepseek-ai/dsh-container'
import type { ContainerCliRunner } from '@deepseek-ai/dsh-container-transport'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import K8sContainerRuntime from '../src/index.ts'
import { sandboxMounts } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** 工作区 claim 的挂载点，也是每个挂载源的共同祖先。 */
const ROOT = '/opt/dsh/.dsh'

/** 承载长期共享内容的另一块 claim。 */
const ASSETS = 'shared-assets'

/** 部署与租户在宿主上实际存在的那些根。 */
const LAYOUT = {
  workspaceRoot: `${ROOT}/tenants/sunce-1028/workspace`,
  toolsRoot: `${ROOT}/tools`,
  usersRoot: `${ROOT}/users`,
  systemRoot: `${ROOT}/system`,
  pythonRoot: `${ROOT}/pyenv`,
}

/** 挂载表只看租户这两项。 */
const TENANT: Pick<Tenant, 'workspaceRoot' | 'toolsRoot'> = {
  workspaceRoot: LAYOUT.workspaceRoot,
  toolsRoot: LAYOUT.toolsRoot,
}

const SUBJECT = 'user_1'

/**
 * 只记下 argv 的假 runner：构造期唯一的外呼是收尸，这些用例不需要任何集群事实。
 */
class FakeRunner implements ContainerCliRunner {
  readonly calls: string[][] = []

  async run(args: readonly string[], _opts?: ContainerExecOptions): Promise<ContainerCommandResult> {
    this.calls.push([...args])
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

/** 覆盖项：允许显式传 `undefined`，用来构造「配了一半」的组合。 */
type ConfigOverrides = { [K in keyof Config]?: Config[K] | undefined }

/** 默认配置叠上覆盖项；`as Config` 承接刻意构造的配置。 */
const config = (overrides: ConfigOverrides = {}): Config => ({
  namespace: 'dsh',
  image: 'dsh-tool-exec:latest',
  kubectlBinary: 'kubectl',
  imagePullPolicy: 'IfNotPresent',
  toolExecPort: 8642,
  usersRoot: LAYOUT.usersRoot,
  systemRoot: LAYOUT.systemRoot,
  toolsRoot: LAYOUT.toolsRoot,
  pythonRoot: LAYOUT.pythonRoot,
  workspaceClaim: 'dsh-workspace',
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

/** 构造即校验：配置错必须在加载时失败，而不是等到第一次建沙箱。 */
const build = (overrides: ConfigOverrides): K8sContainerRuntime =>
  new K8sContainerRuntime(new Context(), config(overrides), new FakeRunner())

describe('资产卷', () => {
  it('命中的源改由资产卷承载，挂载点与只读性不变', () => {
    const mounts = sandboxMounts(config({
      assetMounts: [
        { source: LAYOUT.systemRoot, claim: ASSETS, subPath: 'dsh/system' },
        { source: LAYOUT.pythonRoot, claim: ASSETS, subPath: 'dsh/pyenv' },
      ],
    }), TENANT, SUBJECT)
    // 沙箱里仍是同一个位置：换的只是内容由哪块 claim 承载。
    expect(mounts.find(m => m.mountPath === LAYOUT.systemRoot))
      .toMatchObject({ kind: 'claim', claimName: ASSETS, subPath: 'dsh/system', readOnly: true })
    expect(mounts.find(m => m.mountPath === LAYOUT.pythonRoot))
      .toMatchObject({ kind: 'claim', claimName: ASSETS, subPath: 'dsh/pyenv', readOnly: true })
  })

  it('未命中的源仍投影到工作区 claim，subPath 相对 claimRoot 换算', () => {
    const mounts = sandboxMounts(config({
      assetMounts: [{ source: LAYOUT.pythonRoot, claim: ASSETS, subPath: 'dsh/pyenv' }],
    }), TENANT, SUBJECT)
    expect(mounts.find(m => m.mountPath === '/case'))
      .toMatchObject({ kind: 'claim', claimName: 'dsh-workspace', subPath: 'tenants/sunce-1028/workspace/work' })
    expect(mounts.find(m => m.mountPath === '/tools'))
      .toMatchObject({ kind: 'claim', claimName: 'dsh-workspace', subPath: 'tools' })
  })

  it('命名了一个不是来源的路径时点名报错，而不是静默忽略', () => {
    const typo = `${LAYOUT.pythonRoot}v`
    expect(() => sandboxMounts(config({
      assetMounts: [{ source: typo, claim: ASSETS, subPath: 'dsh/pyenv' }],
    }), TENANT, SUBJECT)).toThrow(/pyenvv'.*is not one of this tenant's mount sources/)
  })

  it('没有 claim 时拒绝资产卷：hostPath 模式没有东西可投影', () => {
    expect(() => build({
      workspaceClaim: undefined,
      claimRoot: undefined,
      assetMounts: [{ source: LAYOUT.pythonRoot, claim: ASSETS, subPath: 'dsh/pyenv' }],
    })).toThrow(/assetMounts requires Config\.workspaceClaim and Config\.claimRoot/)
  })

  it('拒绝同一个源的重复声明：后者会覆盖前者，而两条看起来都生效了', () => {
    expect(() => build({
      assetMounts: [
        { source: LAYOUT.pythonRoot, claim: ASSETS, subPath: 'dsh/pyenv' },
        { source: `${LAYOUT.pythonRoot}/`, claim: 'other', subPath: 'pyenv' },
      ],
    })).toThrow(/names the same source more than once/)
  })

  it('拒绝逃出 claim 的 subPath 与空 claim', () => {
    expect(() => build({ assetMounts: [{ source: LAYOUT.pythonRoot, claim: ASSETS, subPath: '../pyenv' }] }))
      .toThrow(/subPath must be a non-empty path inside that claim/)
    expect(() => build({ assetMounts: [{ source: LAYOUT.pythonRoot, claim: ASSETS, subPath: '/opt/pyenv' }] }))
      .toThrow(/subPath must be a non-empty path inside that claim/)
    expect(() => build({ assetMounts: [{ source: LAYOUT.pythonRoot, claim: ' ', subPath: 'dsh/pyenv' }] }))
      .toThrow(/claim is empty/)
  })

  it('拒绝相对路径的源：挂载点与宿主路径必须一致', () => {
    expect(() => build({ assetMounts: [{ source: 'dsh/pyenv', claim: ASSETS, subPath: 'dsh/pyenv' }] }))
      .toThrow(/must be an absolute path/)
  })
})

/**
 * 整卷挂载：共享资产卷只按「一整块只读卷」挂进来，卷内有什么由部署的程序配置解释。
 *
 * 为什么钉死这几条：卷内布局不再由 chart 决定，因此这里必须固定「挂了几次、带不带 subPath、
 * 卷内的层会不会被重复挂、以及成对与互不包含两条加载期硬失败」——这些一旦放松，
 * 换布局就会悄悄变成「同一份数据出现在两条路径上」或「删租户把运行时一起删掉」。
 */
describe('资产卷整块挂载', () => {
  /** 资产卷的挂载点：与工作区 claim 的根互不包含。 */
  const ASSETS_ROOT = '/opt/assets'

  /** 卷内布局由程序声明：两层都在卷里，因此不再需要 assetMounts 逐层投影。 */
  const assetsConfig = (overrides: ConfigOverrides = {}): Config => config({
    assetsClaim: ASSETS,
    assetsRoot: ASSETS_ROOT,
    systemRoot: `${ASSETS_ROOT}/system`,
    pythonRoot: `${ASSETS_ROOT}/pyenv`,
    ...overrides,
  })

  it('整卷只读挂一次，且不带 subPath', () => {
    const mounts = sandboxMounts(assetsConfig(), TENANT, SUBJECT)
    const root = mounts.filter(m => m.mountPath === ASSETS_ROOT)
    expect(root).toHaveLength(1)
    expect(root[0]).toMatchObject({ kind: 'claim', claimName: ASSETS, readOnly: true })
    // 空串会被 kubelet 当成一条不存在的子目录，所以这里必须是「没有这个字段」。
    expect(root[0]).not.toHaveProperty('subPath')
  })

  it('卷内的层不再单独挂载：整卷已经让它们可见', () => {
    const mounts = sandboxMounts(assetsConfig(), TENANT, SUBJECT)
    expect(mounts.find(m => m.mountPath === `${ASSETS_ROOT}/system`)).toBeUndefined()
    expect(mounts.find(m => m.mountPath === `${ASSETS_ROOT}/pyenv`)).toBeUndefined()
  })

  it('挂到别处的技能聚合根仍单独挂，subPath 相对卷根', () => {
    const mounts = sandboxMounts(assetsConfig(), TENANT, SUBJECT)
    expect(mounts.find(m => m.mountPath === '/opt/data/skills/system')).toMatchObject({
      kind: 'claim',
      claimName: ASSETS,
      subPath: 'system/skills',
      readOnly: true,
    })
  })

  it('卷外的层照旧投影到工作区 claim', () => {
    const mounts = sandboxMounts(assetsConfig(), TENANT, SUBJECT)
    expect(mounts.find(m => m.mountPath === '/tools'))
      .toMatchObject({ kind: 'claim', claimName: 'dsh-workspace', subPath: 'tools' })
  })

  it('claim 与挂载点必须成对给出', () => {
    expect(() => build({ assetsClaim: ASSETS }))
      .toThrow(/assetsClaim and Config\.assetsRoot must be set together/)
    expect(() => build({ assetsRoot: ASSETS_ROOT }))
      .toThrow(/assetsClaim and Config\.assetsRoot must be set together/)
  })

  it('拒绝与工作区 claim 互相包含的挂载点：删租户会连带删掉运行时', () => {
    expect(() => build({ assetsClaim: ASSETS, assetsRoot: `${ROOT}/assets` }))
      .toThrow(/must not contain each other/)
  })

  it('没有 claim 模式时拒绝整卷挂载', () => {
    expect(() => build({ workspaceClaim: undefined, claimRoot: undefined, assetsClaim: ASSETS, assetsRoot: ASSETS_ROOT }))
      .toThrow(/assetsRoot requires Config\.workspaceClaim and Config\.claimRoot/)
  })
})
