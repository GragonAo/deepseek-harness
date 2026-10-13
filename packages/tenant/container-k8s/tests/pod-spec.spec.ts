/**
 * Kubernetes 沙箱 provider 纯规划层的行为：挂载约定、命名规则、指纹，
 * 以及从观测到的 Pod 状态到一句说明的映射。这些都是「答错时只会悄悄出错、
 * 不会大声崩掉」的决定，所以在这里钉死。
 */
import { describe, expect, it } from 'vitest'
import { buildSandboxPod, sandboxPodName, volumeName } from '../src/pod-spec.ts'
import { parsePodStatus, sandboxMounts } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

function config(overrides: Partial<Config> = {}): Config {
  return {
    namespace: 'dsh',
    image: 'dsh-tool-exec:latest',
    toolExecPort: 8642,
    usersRoot: '/root/.dsh/users',
    systemRoot: '/root/.dsh/system',
    toolsRoot: '/root/work/tools',
    pythonRoot: '/opt/.dsh/pyenv',
    ...overrides,
  }
}

/**
 * 一个删掉了指定可选根的配置。`exactOptionalPropertyTypes` 区分「键不存在」与
 * 「键被设成 `undefined`」，而 provider 自己的检查看的是「不存在」，
 * 所以测试必须真的构造出「不存在」，而不是传入这个值。
 * @param keys - 要移除的可选根。
 * @returns 不含这些键的配置。
 */
function configWithout(...keys: (keyof Config)[]): Config {
  const kept = Object.entries(config()).filter(([key]) => !keys.includes(key as keyof Config))
  return Object.fromEntries(kept)
}

/**
 * 挂载规划用到的租户记录字段。`workspaceRoot` 决定工作区各层从哪里挂，
 * `toolsRoot` 是本租户自己的工具图谱；不传它就等于租户记录没写这一项，
 * 此时 `/tools` 回落到配置里的同名根。
 * @param workspaceRoot - 租户自己的工作区根。
 * @param toolsRoot - 租户自己的工具图谱根，若有。
 * @returns 规划层看得到的租户记录。
 */
function tenantScope(workspaceRoot: string, toolsRoot?: string): { workspaceRoot: string; toolsRoot?: string } {
  return { workspaceRoot, ...(toolsRoot === undefined ? {} : { toolsRoot }) }
}

describe('sandbox mounts', () => {
  it('承认为可写时案件共享与用户全局目录不再只读，技能层始终只读', () => {
    const mounts = sandboxMounts(
      config({ sharedReadOnly: false, usersReadOnly: false }),
      tenantScope('/root/work/tenants/acme/workspace'),
      'user_1',
    )
    const byPath = new Map(mounts.map(m => [m.mountPath, m]))
    expect(byPath.get('/shared')?.readOnly).toBe(false)
    expect(byPath.get('/global')?.readOnly).toBe(false)
    // 这个开关管的是数据目录；技能层必须始终只读，否则模型能改自己的指令。
    expect(byPath.get('/root/work/tenants/acme/workspace/shared/skills')?.readOnly).toBe(true)
    expect(byPath.get('/opt/data/skills/case')?.readOnly).toBe(true)
  })

  it('binds every mount source at a path the sandbox can resolve, with the mode the runtime expects', () => {
    const mounts = sandboxMounts(config(), tenantScope('/root/work/tenants/acme/workspace'), 'user_1')
    const byPath = new Map(mounts.map(m => [m.mountPath, m]))

    expect(byPath.get('/workspace')).toEqual({ kind: 'hostPath', source: '/root/work/tenants/acme/workspace/users/user_1', mountPath: '/workspace', readOnly: false })
    // 案件共享与用户全局目录默认只读：它们由业务侧写入，沙箱只是读取方。
    expect(byPath.get('/shared')).toEqual({ kind: 'hostPath', source: '/root/work/tenants/acme/workspace/shared', mountPath: '/shared', readOnly: true })
    expect(byPath.get('/global')).toEqual({ kind: 'hostPath', source: '/root/.dsh/users/user_1', mountPath: '/global', readOnly: true })
    expect(byPath.get('/tools')).toEqual({ kind: 'hostPath', source: '/root/work/tools', mountPath: '/tools', readOnly: true })

    // 来源是 skill 树或运行时的挂载，必须出现在 host 解析出的那个路径上：
    // skill 的伴随文件是按它们被发现时的目录来引用的。
    expect(byPath.get('/root/work/tenants/acme/workspace/shared/skills')).toEqual({
      kind: 'hostPath',
      source: '/root/work/tenants/acme/workspace/shared/skills',
      mountPath: '/root/work/tenants/acme/workspace/shared/skills',
      readOnly: true,
    })
    expect(byPath.get('/root/.dsh/system')?.readOnly).toBe(true)
    expect(byPath.get('/opt/.dsh/pyenv')?.readOnly).toBe(true)

    // 技能三层同时落在聚合根下：案件脚本遍历那个根去发现技能，而一次挂载只能把一个来源
    // 放到一个位置，所以层与层之间只能靠子目录分开——同名技能可能同时存在于多层。
    expect(byPath.get('/opt/data/skills/case')).toEqual({
      kind: 'hostPath',
      source: '/root/work/tenants/acme/workspace/shared/skills',
      mountPath: '/opt/data/skills/case',
      readOnly: true,
    })
    expect(byPath.get('/opt/data/skills/user-global')).toEqual({
      kind: 'hostPath', source: '/root/.dsh/users/user_1/skills', mountPath: '/opt/data/skills/user-global', readOnly: true,
    })
    expect(byPath.get('/opt/data/skills/system')).toEqual({
      kind: 'hostPath', source: '/root/.dsh/system/skills', mountPath: '/opt/data/skills/system', readOnly: true,
    })
    expect(mounts.filter(m => m.mountPath.startsWith('/opt/data/skills')).every(m => m.readOnly)).toBe(true)
    expect(mounts).toHaveLength(10)
  })

  it('projects every mount onto the shared claim, leaving no hostPath behind', () => {
    const mounts = sandboxMounts(
      config({ workspaceClaim: 'dsh-cephfs', claimRoot: '/' }),
      tenantScope('/root/work/tenants/acme/workspace'),
      'user_1',
    )
    const byPath = new Map(mounts.map(m => [m.mountPath, m]))

    // 每一层都算，不只是租户自己的数据：只要还留着一个 hostPath，
    // Pod 就被钉在某个节点上，而 claim 存在的意义正是去掉这种耦合。
    expect(mounts.every(m => m.kind === 'claim')).toBe(true)
    expect(byPath.get('/workspace')).toEqual({
      kind: 'claim', claimName: 'dsh-cephfs', subPath: 'root/work/tenants/acme/workspace/users/user_1', mountPath: '/workspace', readOnly: false,
    })
    expect(byPath.get('/tools')).toEqual({
      kind: 'claim', claimName: 'dsh-cephfs', subPath: 'root/work/tools', mountPath: '/tools', readOnly: true,
    })

    // 沙箱内路径与 hostPath 模式完全一致，因此切换模式不会改变任何读取方解析到的地址。
    const hostMode = sandboxMounts(config(), tenantScope('/root/work/tenants/acme/workspace'), 'user_1')
    expect(mounts.map(m => m.mountPath)).toEqual(hostMode.map(m => m.mountPath))
    expect(mounts.map(m => m.readOnly)).toEqual(hostMode.map(m => m.readOnly))
  })

  it('refuses a source outside the claim root instead of emitting an escaping subPath', () => {
    // 爬出 claim 的相对路径会解析到 claim 里并不存在的目录，
    // 而 Kubernetes 会把它挂成一个空目录。
    expect(() =>
      sandboxMounts(config({ workspaceClaim: 'dsh-cephfs', claimRoot: '/root/work' }), tenantScope('/root/work/tenants/acme/workspace'), 'u'),
    ).toThrow(/outside claimRoot '\/root\/work'/)
  })

  it('omits the optional mounts when their roots are not configured', () => {
    const mounts = sandboxMounts(configWithout('usersRoot', 'systemRoot', 'toolsRoot', 'pythonRoot'), tenantScope('/ws'), 'u')
    expect(mounts.map(m => m.mountPath)).toEqual(['/workspace', '/shared', '/ws/shared/skills', '/opt/data/skills/case'])
  })

  it('takes /tools from the tenant record and falls back to the configured root', () => {
    const toolsOf = (mounts: ReturnType<typeof sandboxMounts>) => mounts.find(m => m.mountPath === '/tools')

    // 租户记录优先：工具图谱是租户自己的，配置里那份只是缺省。
    expect(toolsOf(sandboxMounts(config(), tenantScope('/ws', '/tenant/tools'), 'u'))).toEqual({
      kind: 'hostPath', source: '/tenant/tools', mountPath: '/tools', readOnly: true,
    })
    // 租户记录没写这一项时才回落到配置。
    expect(toolsOf(sandboxMounts(config(), tenantScope('/ws'), 'u'))).toEqual({
      kind: 'hostPath', source: '/root/work/tools', mountPath: '/tools', readOnly: true,
    })
    // 两处都没有就是没有 /tools，而不是挂一个空目录。
    expect(toolsOf(sandboxMounts(configWithout('toolsRoot'), tenantScope('/ws'), 'u'))).toBeUndefined()
  })

  it('mounts the tiers that carry host paths at that path, and everything else at a fixed sandbox path', () => {
    const mounts = sandboxMounts(config(), tenantScope('/ws'), 'u')
    // 必须原样往返的路径：技能树、system 层、Python 层——落在它们里面的文件互相引用那些绝对路径。
    expect(mounts.filter(m => m.kind === 'hostPath' && m.mountPath === m.source).map(m => m.mountPath))
      .toEqual(['/ws/shared/skills', '/root/.dsh/system', '/opt/.dsh/pyenv'])
    // 聚合根下的层目录是固定位置，与宿主布局无关：案件脚本照着固定根遍历。
    expect(mounts.filter(m => m.mountPath.startsWith('/opt/data/skills')).map(m => m.mountPath))
      .toEqual(['/opt/data/skills/case', '/opt/data/skills/user-global', '/opt/data/skills/system'])
  })
})

describe('sandbox naming', () => {
  it('produces an RFC1123 name of at most 63 characters for subjects the cluster cannot name directly', () => {
    for (const [tenant, subject] of [['sunce-1028', 'investigator-1'], ['acme', 'user_1'], ['A.B', 'Ünïcode／名'], ['x'.repeat(80), 'y'.repeat(80)]] as const) {
      const name = sandboxPodName(tenant, subject)
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(RFC1123)
      expect(name).not.toContain('_')
    }
  })

  it('separates two scopes that fold to the same characters', () => {
    expect(sandboxPodName('acme', 'user_1')).not.toBe(sandboxPodName('acme', 'user-1'))
    expect(sandboxPodName('a-b', 'c')).not.toBe(sandboxPodName('a', 'b-c'))
  })

  it('is stable for the same scope', () => {
    expect(sandboxPodName('acme', 'user_1')).toBe(sandboxPodName('acme', 'user_1'))
  })
})

describe('volume naming', () => {
  it('gives distinct backing stores distinct volume names even when they fold together', () => {
    expect(volumeName('path:/a/b')).not.toBe(volumeName('path:/a-b'))
    expect(volumeName('claim:dsh-cephfs')).toMatch(RFC1123)
    expect(volumeName('claim:dsh-cephfs')).toBe(volumeName('claim:dsh-cephfs'))
  })
})

describe('pod assembly', () => {
  const mounts = sandboxMounts(config(), tenantScope('/ws'), 'u')
  const WORK_DIR = '/tmp/work'
  const built = buildSandboxPod({
    namespace: 'dsh', image: 'dsh-tool-exec:latest', imagePullPolicy: 'IfNotPresent',
    podName: 'dsh-acme-u-abc123', command: ['node', '/opt/dsh/tool-exec.mjs'], mounts,
    env: { DSH_TOOL_EXEC_PORT: '8642' }, toolExecPort: 8642, workDir: WORK_DIR,
  })

  it('declares one volume and one volumeMount per mount, in the same order', () => {
    const spec = built.spec.spec as {
      volumes: { name: string }[]
      containers: { volumeMounts: { name: string; mountPath: string; readOnly: boolean }[] }[]
    }
    // 卷按「数据从哪里读」去重，不按「在沙箱里出现在哪里」：同一棵技能树既按宿主路径挂、
    // 又落进聚合根，因此共用一卷。只读根另外需要一个临时卷。
    const backing = (m: (typeof mounts)[number]) => (m.kind === 'claim' ? `claim:${m.claimName}` : `path:${m.source}`)
    // 除数据卷外还有两个容器本地空目录：/tmp 供只读根下的临时文件，WORK_DIR 是执行容器的工作目录。
    expect(spec.volumes).toHaveLength(new Set(mounts.map(backing)).size + 2)
    expect(spec.volumes.map(v => v.name).slice(-2)).toEqual(['tmp', 'work'])
    expect(spec.containers[0]!.volumeMounts.map(v => v.mountPath).slice(0, mounts.length)).toEqual(mounts.map(m => m.mountPath))
    expect(spec.containers[0]!.volumeMounts.map(v => v.name).slice(0, mounts.length)).toEqual(mounts.map(m => volumeName(backing(m))))
    expect(spec.containers[0]!.volumeMounts.map(v => v.readOnly).slice(0, mounts.length)).toEqual(mounts.map(m => m.readOnly))
    expect(spec.containers[0]!.volumeMounts.slice(-2)).toEqual([
      { name: 'tmp', mountPath: '/tmp', readOnly: false },
      { name: 'work', mountPath: WORK_DIR, readOnly: false },
    ])
  })

  it('declares one volume per backing store, so several mounts of one claim stay one volume', () => {
    const claimMounts = sandboxMounts(config({ workspaceClaim: 'dsh-cephfs', claimRoot: '/' }), tenantScope('/ws'), 'u')
    const claimBuilt = buildSandboxPod({
      namespace: 'dsh', image: 'dsh-tool-exec:latest', imagePullPolicy: 'IfNotPresent',
      podName: 'dsh-acme-u-abc123', command: ['node', '/opt/dsh/tool-exec.mjs'], mounts: claimMounts,
      env: { DSH_TOOL_EXEC_PORT: '8642' }, toolExecPort: 8642, workDir: WORK_DIR,
    })
    const spec = claimBuilt.spec.spec as {
      volumes: { name: string; persistentVolumeClaim?: { claimName: string } }[]
      containers: { volumeMounts: { name: string; subPath?: string }[] }[]
      initContainers: { volumeMounts: { name: string; subPath?: string }[] }[]
    }
    const subPaths = claimMounts.map(m => (m.kind === 'claim' ? m.subPath : ''))

    // kubelet 按后端卷记录挂载状态，所以被第二个卷命名的 claim 永远报告不成「已挂载」：
    // 于是 Pod 过不了 init 容器，每一轮 sync 都以超时收场。
    expect(spec.volumes.map(v => v.name)).toEqual([volumeName('claim:dsh-cephfs'), 'tmp', 'work'])
    expect(spec.volumes[0]!.persistentVolumeClaim).toEqual({ claimName: 'dsh-cephfs' })

    const container = spec.containers[0]!.volumeMounts
    expect(container.map(v => v.name).slice(0, claimMounts.length)).toEqual(claimMounts.map(() => volumeName('claim:dsh-cephfs')))
    expect(container.map(v => v.subPath).slice(0, claimMounts.length)).toEqual(subPaths)

    // 校验容器少了 subPath，就会把 claim 的根当作租户自己的子树放过去，
    // 而那正是它存在的意义所在。
    expect(spec.initContainers[0]!.volumeMounts.map(v => v.subPath)).toEqual(subPaths)
  })

  it('is a bare Pod that no controller would recreate, and that admits no Cluster network identity', () => {
    const spec = built.spec.spec
    expect(built.spec.kind).toBe('Pod')
    expect(spec.restartPolicy).toBe('Never')
    expect(spec.automountServiceAccountToken).toBe(false)
    expect(spec.hostNetwork).toBe(false)
  })

  it('verifies every mount from inside the sandbox after the kubelet has mounted it', () => {
    const spec = built.spec.spec as { initContainers: { command: string[]; volumeMounts: unknown[] }[] }
    expect(spec.initContainers).toHaveLength(1)
    const script = spec.initContainers[0]!.command.join(' ')
    // 检查必须写沙箱看得见的东西，而不是 host 把它放在哪里。
    for (const m of mounts) expect(script).toContain(m.mountPath)
    expect(script).not.toContain('/root/work/tenants')
    expect(script).toContain('MISSING')
    expect(spec.initContainers[0]!.volumeMounts).toHaveLength(mounts.length)
  })

  it('leaves a writable scratch directory because the root filesystem is read-only', () => {
    const spec = built.spec.spec as {
      containers: { volumeMounts: { mountPath: string; readOnly: boolean }[] }[]
      initContainers: { volumeMounts: unknown[] }[]
    }
    expect(spec.containers[0]!.volumeMounts.some(v => v.mountPath === '/tmp' && !v.readOnly)).toBe(true)
    // 校验容器只读，不需要临时空间。
    expect(spec.initContainers[0]!.volumeMounts).toHaveLength(mounts.length)
  })

  it('drops the capabilities a sandbox never needs', () => {
    const container = (built.spec.spec as { containers: { securityContext: Record<string, unknown> }[] }).containers[0]!
    expect(container.securityContext).toMatchObject({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true })
  })

  it('fingerprints the resolved spec so a changed mount set cannot look like the same sandbox', () => {
    const other = buildSandboxPod({
      namespace: 'dsh', image: 'dsh-tool-exec:latest', imagePullPolicy: 'IfNotPresent',
      podName: 'dsh-acme-u-abc123', command: ['node', '/opt/dsh/tool-exec.mjs'],
      mounts: sandboxMounts(config(), tenantScope('/ws', '/other/tools'), 'u'),
      env: { DSH_TOOL_EXEC_PORT: '8642' }, toolExecPort: 8642, workDir: WORK_DIR,
    })
    expect(built.fingerprint).not.toBe(other.fingerprint)
    expect(built.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fingerprints the same inputs identically regardless of key order', () => {
    const a = buildSandboxPod({ namespace: 'dsh', image: 'i', imagePullPolicy: 'IfNotPresent', podName: 'p', command: ['c'], mounts, env: { B: '2', A: '1' }, toolExecPort: 1, workDir: WORK_DIR })
    const b = buildSandboxPod({ namespace: 'dsh', image: 'i', imagePullPolicy: 'IfNotPresent', podName: 'p', command: ['c'], mounts, env: { A: '1', B: '2' }, toolExecPort: 1, workDir: WORK_DIR })
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})

describe('observed pod state', () => {
  it('reports a running, ready pod with its address and fingerprint', () => {
    const status = parsePodStatus(JSON.stringify({
      metadata: { annotations: { 'dsh.dev/spec-fingerprint': 'abc' } },
      status: { phase: 'Running', podIP: '10.244.0.7', conditions: [{ type: 'Ready', status: 'True' }] },
    }))
    expect(status).toEqual({ phase: 'Running', ready: true, podIP: '10.244.0.7', fingerprint: 'abc' })
  })

  it('explains an init container that refused a mount instead of reporting a bare phase', () => {
    const status = parsePodStatus(JSON.stringify({
      metadata: {}, status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'False' }], initContainerStatuses: [{ state: { terminated: { reason: 'Error', message: 'MISSING /ws/shared' } } }] },
    }))
    expect(status.phase).toBe('Pending')
    expect(status.ready).toBe(false)
    expect(status.detail).toContain('MISSING /ws/shared')
  })
})
