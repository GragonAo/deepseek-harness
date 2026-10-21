/**
 * Kubernetes 沙箱 provider 纯规划层的行为：挂载约定、命名规则、指纹，
 * 以及从观测到的 Pod 状态到一句说明的映射。这些都是「答错时只会悄悄出错、
 * 不会大声崩掉」的决定，所以在这里钉死。
 */
import { describe, expect, it } from 'vitest'
import { assertQuantity, buildSandboxPod, readOnlyOf, sandboxPodName, sandboxResources, volumeName } from '../src/pod-spec.ts'
import { parsePodStatus, sandboxMounts, withLocalMountPoint } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** The backing store a mount reads from — the key that decides which volume serves it. */
function backing(m: ReturnType<typeof sandboxMounts>[number]): string {
  if (m.kind === 'claim') return `claim:${m.claimName}`
  if (m.kind === 'local') return `local:${m.mountPath}`
  return `path:${m.source}`
}

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
      config({ caseReadOnly: false, usersReadOnly: false }),
      tenantScope('/root/work/tenants/acme/workspace'),
      'user_1',
    )
    const byPath = new Map(mounts.map(m => [m.mountPath, m]))
    expect(byPath.get('/case')).toMatchObject({ readOnly: false })
    expect(byPath.get('/global')).toMatchObject({ readOnly: false })
    // 这个开关管的是数据目录；技能层必须始终只读，否则模型能改自己的指令。
    expect(byPath.get('/root/work/tenants/acme/workspace/skills')).toMatchObject({ readOnly: true })
    expect(byPath.get('/opt/data/skills/case')).toMatchObject({ readOnly: true })
  })

  it('binds every mount source at a path the sandbox can resolve, with the mode the runtime expects', () => {
    const mounts = sandboxMounts(config(), tenantScope('/root/work/tenants/acme/workspace'), 'user_1')
    const byPath = new Map(mounts.map(m => [m.mountPath, m]))

    expect(byPath.get('/workspace')).toEqual({ kind: 'hostPath', source: '/root/work/tenants/acme/workspace/users/user_1/work', mountPath: '/workspace', readOnly: false })
    // 会话工作目录单独一层挂：它与用户案件工作区同层时，挂载 `/workspace` 就会把这个人的
    // 全部会话目录一起交出去。
    expect(byPath.get('/sessions')).toEqual({ kind: 'hostPath', source: '/root/work/tenants/acme/workspace/users/user_1/sessions', mountPath: '/sessions', readOnly: false })
    // 案件共享与用户全局目录默认只读：它们由业务侧写入，沙箱只是读取方。
    expect(byPath.get('/case')).toEqual({ kind: 'hostPath', source: '/root/work/tenants/acme/workspace/work', mountPath: '/case', readOnly: true })
    expect(byPath.get('/global')).toEqual({ kind: 'hostPath', source: '/root/.dsh/users/user_1/work', mountPath: '/global', readOnly: true })
    expect(byPath.get('/tools')).toEqual({ kind: 'hostPath', source: '/root/work/tools', mountPath: '/tools', readOnly: true })

    // 来源是 skill 树或运行时的挂载，必须出现在 host 解析出的那个路径上：
    // skill 的伴随文件是按它们被发现时的目录来引用的。
    expect(byPath.get('/root/work/tenants/acme/workspace/skills')).toEqual({
      kind: 'hostPath',
      source: '/root/work/tenants/acme/workspace/skills',
      mountPath: '/root/work/tenants/acme/workspace/skills',
      readOnly: true,
    })
    expect(byPath.get('/root/.dsh/system')).toMatchObject({ readOnly: true })
    expect(byPath.get('/opt/.dsh/pyenv')).toMatchObject({ readOnly: true })

    // 技能三层同时落在聚合根下：案件脚本遍历那个根去发现技能，而一次挂载只能把一个来源
    // 放到一个位置，所以层与层之间只能靠子目录分开——同名技能可能同时存在于多层。
    expect(byPath.get('/opt/data/skills/case')).toEqual({
      kind: 'hostPath',
      source: '/root/work/tenants/acme/workspace/skills',
      mountPath: '/opt/data/skills/case',
      readOnly: true,
    })
    expect(byPath.get('/opt/data/skills/user-global')).toEqual({
      kind: 'hostPath', source: '/root/.dsh/users/user_1/skills', mountPath: '/opt/data/skills/user-global', readOnly: true,
    })
    expect(byPath.get('/opt/data/skills/system')).toEqual({
      kind: 'hostPath', source: '/root/.dsh/system/skills', mountPath: '/opt/data/skills/system', readOnly: true,
    })
    // 聚合根本身是容器本地可写目录：它是那三层的父目录，只读就建不出挂载点。
    expect(byPath.get('/opt/data/skills')).toEqual({ kind: 'local', mountPath: '/opt/data/skills' })
    expect(mounts.filter(m => m.mountPath.startsWith('/opt/data/skills/')).every(m => m.kind === 'hostPath' && m.readOnly)).toBe(true)
    expect(mounts).toHaveLength(12)
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
    // 除了聚合根那个容器本地空目录：它没有后端存储，所以 claim 说不了它。
    expect(mounts.every(m => m.kind === 'claim' || m.kind === 'local')).toBe(true)
    expect(byPath.get('/workspace')).toEqual({
      kind: 'claim', claimName: 'dsh-cephfs', subPath: 'root/work/tenants/acme/workspace/users/user_1/work', mountPath: '/workspace', readOnly: false,
    })
    expect(byPath.get('/tools')).toEqual({
      kind: 'claim', claimName: 'dsh-cephfs', subPath: 'root/work/tools', mountPath: '/tools', readOnly: true,
    })

    // 沙箱内路径与 hostPath 模式完全一致，因此切换模式不会改变任何读取方解析到的地址。
    const hostMode = sandboxMounts(config(), tenantScope('/root/work/tenants/acme/workspace'), 'user_1')
    expect(mounts.map(m => m.mountPath)).toEqual(hostMode.map(m => m.mountPath))
    expect(mounts.map(readOnlyOf)).toEqual(hostMode.map(readOnlyOf))
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
    expect(mounts.map(m => m.mountPath)).toEqual(['/workspace', '/sessions', '/case', '/ws/skills', '/opt/data/skills', '/opt/data/skills/case'])
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
      .toEqual(['/ws/skills', '/root/.dsh/system', '/opt/.dsh/pyenv'])
    // 聚合根下的层目录是固定位置，与宿主布局无关：案件脚本照着固定根遍历。
    expect(mounts.filter(m => m.mountPath.startsWith('/opt/data/skills/')).map(m => m.mountPath))
      .toEqual(['/opt/data/skills/case', '/opt/data/skills/user-global', '/opt/data/skills/system'])
  })

  it('puts the writable aggregate root immediately before the tiers that hang under it', () => {
    const mounts = sandboxMounts(config(), tenantScope('/ws'), 'u')
    const root = mounts.findIndex(m => m.mountPath === '/opt/data/skills')

    // 只读挂载里造不出子挂载点，所以聚合根必须是容器本地可写的，而且必须排在那三层之前：
    // 排在后面就来不及为它们建挂载点，Pod 会一直停在 init 容器。
    expect(root).toBeGreaterThan(0)
    expect(mounts[root]).toEqual({ kind: 'local', mountPath: '/opt/data/skills' })
    // 三层并不相邻：每层都紧跟在自己的来源后面。要紧的是三层**全都**在聚合根之后，
    // 否则它们的挂载点会在本地目录挂上之前就要被造出来。
    expect(mounts.filter((m, i) => i > root && m.mountPath.startsWith('/opt/data/skills/'))).toHaveLength(3)
  })

  it('leaves a list with nothing under the writable root untouched', () => {
    const mounts = sandboxMounts(config(), tenantScope('/ws'), 'u')
    const withoutTiers = mounts.filter(m => !m.mountPath.startsWith('/opt/data/skills/'))

    // 没有嵌在它下面的挂载就没有要保护的挂载点：多插一个空目录只是白造一个挂载点。
    expect(withLocalMountPoint(withoutTiers, '/opt/data/skills')).toEqual(withoutTiers)
  })
})

describe('sandbox naming', () => {
  it('produces an RFC1123 name of at most 63 characters for subjects the cluster cannot name directly', () => {
    for (const [tenant, subject] of [['sunce-1028', 'investigator-1'], ['acme', 'user_1'], ['A.B', '\'Ünïcode／名'], ['x'.repeat(80), 'y'.repeat(80)]] as const) {
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
    // 除数据卷外还有两个容器本地空目录：/tmp 供只读根下的临时文件，WORK_DIR 是执行容器的工作目录。
    expect(spec.volumes).toHaveLength(new Set(mounts.map(backing)).size + 2)
    expect(spec.volumes.map(v => v.name).slice(-2)).toEqual(['tmp', 'work'])
    expect(spec.containers[0]!.volumeMounts.map(v => v.mountPath).slice(0, mounts.length)).toEqual(mounts.map(m => m.mountPath))
    expect(spec.containers[0]!.volumeMounts.map(v => v.name).slice(0, mounts.length)).toEqual(mounts.map(m => volumeName(backing(m))))
    expect(spec.containers[0]!.volumeMounts.map(v => v.readOnly).slice(0, mounts.length)).toEqual(mounts.map(readOnlyOf))
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
    const subPaths = claimMounts.map(m => (m.kind === 'claim' ? m.subPath : undefined))

    // kubelet 按后端卷记录挂载状态，所以被第二个卷命名的 claim 永远报告不成「已挂载」：
    // 于是 Pod 过不了 init 容器，每一轮 sync 都以超时收场。
    expect(spec.volumes.map(v => v.name)).toEqual([volumeName('claim:dsh-cephfs'), volumeName('local:/opt/data/skills'), 'tmp', 'work'])
    expect(spec.volumes[0]!.persistentVolumeClaim).toEqual({ claimName: 'dsh-cephfs' })

    const container = spec.containers[0]!.volumeMounts
    expect(container.map(v => v.name).slice(0, claimMounts.length)).toEqual(claimMounts.map(m => volumeName(backing(m))))
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

describe('沙箱资源上限', () => {
  const WORK_DIR = '/tmp/work'

  it('两个上限都配时声明 limits，核数按 quantity 写出', () => {
    expect(sandboxResources('8Gi', 2)).toEqual({ limits: { memory: '8Gi', cpu: '2' } })
  })

  it('只配一个上限时只声明那一个', () => {
    expect(sandboxResources('8Gi', undefined)).toEqual({ limits: { memory: '8Gi' } })
    expect(sandboxResources(undefined, 2)).toEqual({ limits: { cpu: '2' } })
  })

  it('都不配时不上界，Pod 落在 BestEffort', () => {
    expect(sandboxResources(undefined, undefined)).toBeUndefined()
  })

  it('声明给沙箱容器的上限出现在 spec 里，且不写 requests', () => {
    const { spec } = buildSandboxPod({
      namespace: 'dsh', image: 'i', imagePullPolicy: 'IfNotPresent', podName: 'p', command: ['c'],
      mounts: [{ kind: 'local', mountPath: WORK_DIR }], env: {}, toolExecPort: 1, workDir: WORK_DIR,
      resources: { limits: { memory: '8Gi' } },
    })
    const containers = (spec.spec as { containers: { name: string; resources?: unknown }[] }).containers
    expect(containers[0]!.resources).toEqual({ limits: { memory: '8Gi' } })
  })

  it('不配上限时 spec 里没有 resources 字段', () => {
    const { spec } = buildSandboxPod({
      namespace: 'dsh', image: 'i', imagePullPolicy: 'IfNotPresent', podName: 'p', command: ['c'],
      mounts: [{ kind: 'local', mountPath: WORK_DIR }], env: {}, toolExecPort: 1, workDir: WORK_DIR,
    })
    const containers = (spec.spec as { containers: Record<string, unknown>[] }).containers
    expect(containers[0]!.resources).toBeUndefined()
  })
})

describe('quantity 写法的加载期校验', () => {
  it('接受二进制后缀、十进制后缀与裸字节数', () => {
    expect(() => { assertQuantity('Config.memoryLimit', '8Gi') }).not.toThrow()
    expect(() => { assertQuantity('Config.memoryLimit', '500m') }).not.toThrow()
    expect(() => { assertQuantity('Config.memoryLimit', '2') }).not.toThrow()
  })

  it('拒绝 Docker 语法的取值，并在报错里点名配置项', () => {
    expect(() => { assertQuantity('Config.memoryLimit', '2g') }).toThrow(/Config\.memoryLimit/)
  })
})
