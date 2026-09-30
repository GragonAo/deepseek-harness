/**
 * Behaviour of the Kubernetes sandbox provider's pure planning layer: the
 * mount contract, the naming rules, the fingerprint, and the mapping from an
 * observed Pod state to a message. These are the decisions that a wrong answer
 * makes silently wrong rather than loudly broken, so they are pinned here.
 */
import { describe, expect, it } from 'vitest'
import { buildSandboxPod, mountName, sandboxPodName } from '../src/pod-spec.ts'
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
 * A config with the named optional roots absent. `exactOptionalPropertyTypes`
 * distinguishes an absent key from one set to `undefined`, and the provider's
 * own check is for absence, so the test has to build absence rather than pass
 * the value.
 * @param keys - the optional roots to remove.
 * @returns the config without those keys.
 */
function configWithout(...keys: (keyof Config)[]): Config {
  const kept = Object.entries(config()).filter(([key]) => !keys.includes(key as keyof Config))
  return Object.fromEntries(kept)
}

describe('sandbox mounts', () => {
  it('binds every mount source at a path the sandbox can resolve, with the mode the runtime expects', () => {
    const mounts = sandboxMounts(config(), '/root/work/tenants/acme/workspace', 'user_1')
    const byPath = new Map(mounts.map(m => [m.mountPath, m]))

    expect(byPath.get('/workspace')).toEqual({ kind: 'hostPath', source: '/root/work/tenants/acme/workspace/users/user_1', mountPath: '/workspace', readOnly: false })
    expect(byPath.get('/shared')).toEqual({ kind: 'hostPath', source: '/root/work/tenants/acme/workspace/shared', mountPath: '/shared', readOnly: false })
    expect(byPath.get('/global')).toEqual({ kind: 'hostPath', source: '/root/.dsh/users/user_1', mountPath: '/global', readOnly: false })
    expect(byPath.get('/tools')).toEqual({ kind: 'hostPath', source: '/root/work/tools', mountPath: '/tools', readOnly: true })

    // A mount whose source is a skill tree or runtime must appear at the very
    // path the host resolved it to: a skill's companion files are referenced
    // relative to their discovery directory.
    expect(byPath.get('/root/work/tenants/acme/workspace/shared/skills')).toEqual({
      kind: 'hostPath',
      source: '/root/work/tenants/acme/workspace/shared/skills',
      mountPath: '/root/work/tenants/acme/workspace/shared/skills',
      readOnly: true,
    })
    expect(byPath.get('/root/.dsh/system')?.readOnly).toBe(true)
    expect(byPath.get('/opt/.dsh/pyenv')?.readOnly).toBe(true)
    expect(mounts).toHaveLength(7)
  })

  it('projects every mount onto the shared claim, leaving no hostPath behind', () => {
    const mounts = sandboxMounts(
      config({ workspaceClaim: 'dsh-cephfs', claimRoot: '/' }),
      '/root/work/tenants/acme/workspace',
      'user_1',
    )
    const byPath = new Map(mounts.map(m => [m.mountPath, m]))

    // Every tier, not only the tenant's own data: a sandbox that still carried a
    // hostPath would pin the Pod to one node, which is the coupling the claim
    // exists to remove.
    expect(mounts.every(m => m.kind === 'claim')).toBe(true)
    expect(byPath.get('/workspace')).toEqual({
      kind: 'claim', claimName: 'dsh-cephfs', subPath: 'root/work/tenants/acme/workspace/users/user_1', mountPath: '/workspace', readOnly: false,
    })
    expect(byPath.get('/tools')).toEqual({
      kind: 'claim', claimName: 'dsh-cephfs', subPath: 'root/work/tools', mountPath: '/tools', readOnly: true,
    })

    // The in-sandbox paths are identical to hostPath mode, so switching modes
    // changes no address any reader resolves.
    const hostMode = sandboxMounts(config(), '/root/work/tenants/acme/workspace', 'user_1')
    expect(mounts.map(m => m.mountPath)).toEqual(hostMode.map(m => m.mountPath))
    expect(mounts.map(m => m.readOnly)).toEqual(hostMode.map(m => m.readOnly))
  })

  it('refuses a source outside the claim root instead of emitting an escaping subPath', () => {
    // A relative path that climbs out of the claim resolves to a directory the
    // claim does not contain, and Kubernetes mounts it as an empty directory.
    expect(() =>
      sandboxMounts(config({ workspaceClaim: 'dsh-cephfs', claimRoot: '/root/work' }), '/root/work/tenants/acme/workspace', 'u'),
    ).toThrow(/outside claimRoot '\/root\/work'/)
  })

  it('omits the optional mounts when their roots are not configured', () => {
    const mounts = sandboxMounts(configWithout('usersRoot', 'systemRoot', 'toolsRoot', 'pythonRoot'), '/ws', 'u')
    expect(mounts.map(m => m.mountPath)).toEqual(['/workspace', '/shared', '/ws/shared/skills'])
  })

  it('keeps every hostPath source identical to the in-container path when the design requires the same path', () => {
    // Paths that must round-trip unchanged: anything whose in-sandbox location
    // is derived from a host location.
    for (const m of sandboxMounts(config(), '/ws', 'u')) {
      if (m.kind !== 'hostPath') continue
      if (m.mountPath.startsWith('/ws') || m.mountPath.startsWith('/root') || m.mountPath.startsWith('/opt')) {
        expect(m.mountPath).toBe(m.source)
      }
    }
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
  it('gives distinct paths distinct volume names even when they fold together', () => {
    expect(mountName('/a/b')).not.toBe(mountName('/a-b'))
    expect(mountName('/root/.dsh/system')).toMatch(RFC1123)
    expect(mountName('/root/.dsh/system')).toBe(mountName('/root/.dsh/system'))
  })
})

describe('pod assembly', () => {
  const mounts = sandboxMounts(config(), '/ws', 'u')
  const built = buildSandboxPod({
    namespace: 'dsh', image: 'dsh-tool-exec:latest', imagePullPolicy: 'IfNotPresent',
    podName: 'dsh-acme-u-abc123', command: ['node', '/opt/dsh/tool-exec.mjs'], mounts,
    env: { DSH_TOOL_EXEC_PORT: '8642' }, toolExecPort: 8642,
  })

  it('declares one volume and one volumeMount per mount, in the same order', () => {
    const spec = built.spec.spec as {
      volumes: { name: string }[]
      containers: { volumeMounts: { name: string; mountPath: string; readOnly: boolean }[] }[]
    }
    // One volume per mount, plus the scratch volume a read-only root needs.
    expect(spec.volumes).toHaveLength(mounts.length + 1)
    expect(spec.volumes.map(v => v.name).at(-1)).toBe('tmp')
    expect(spec.containers[0]!.volumeMounts.map(v => v.mountPath).slice(0, mounts.length)).toEqual(mounts.map(m => m.mountPath))
    const names = spec.containers[0]!.volumeMounts.map(v => v.name).slice(0, mounts.length)
    expect(names).toEqual(spec.volumes.slice(0, mounts.length).map(v => v.name))
    expect(spec.containers[0]!.volumeMounts.map(v => v.readOnly).slice(0, mounts.length)).toEqual(mounts.map(m => m.readOnly))
    expect(spec.containers[0]!.volumeMounts.at(-1)).toEqual({ name: 'tmp', mountPath: '/tmp', readOnly: false })
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
    // The check must name what the sandbox sees, not where the host keeps it.
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
    // The verifier only reads, so it needs no scratch space.
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
      mounts: sandboxMounts(config({ toolsRoot: '/other/tools' }), '/ws', 'u'),
      env: { DSH_TOOL_EXEC_PORT: '8642' }, toolExecPort: 8642,
    })
    expect(built.fingerprint).not.toBe(other.fingerprint)
    expect(built.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fingerprints the same inputs identically regardless of key order', () => {
    const a = buildSandboxPod({ namespace: 'dsh', image: 'i', imagePullPolicy: 'IfNotPresent', podName: 'p', command: ['c'], mounts, env: { B: '2', A: '1' }, toolExecPort: 1 })
    const b = buildSandboxPod({ namespace: 'dsh', image: 'i', imagePullPolicy: 'IfNotPresent', podName: 'p', command: ['c'], mounts, env: { A: '1', B: '2' }, toolExecPort: 1 })
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
