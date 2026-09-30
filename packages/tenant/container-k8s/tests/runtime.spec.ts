import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import K8sContainerRuntime from '../src/index.ts'

const TENANT = { id: 'sunce-1028', workspaceRoot: '/opt/dsh/tenants/sunce-1028/workspace' }

const config = () => ({
  namespace: 'dsh',
  image: 'dsh-tool-exec:latest',
  usersRoot: '/opt/dsh/.dsh/users',
  systemRoot: '/opt/dsh/.dsh/system',
  toolsRoot: '/opt/dsh/tools',
  pythonRoot: '/opt/dsh/.dsh/pyenv',
  workspaceClaim: 'dsh-workspace',
  claimRoot: '/opt/dsh',
})

function harness(pod: Record<string, unknown> | null, createError = '') {
  const calls: string[][] = []
  let createdSpec = ''
  let created = false
  const runner = {
    async run(args: string[], stdin?: string) {
      calls.push([...args])
      // Even a losing `create` (AlreadyExists) means the winner's sandbox exists.
      if (args[2] === 'create') { createdSpec = stdin ?? ''; created = true }
      if (args[2] === 'get' && args[3] === 'pod') {
        const visible = pod ?? (created ? runningPod(fingerprintOf(createdSpec)) : null)
        if (!visible) return { exitCode: 1, stdout: '', stderr: 'Error from server (NotFound): pods not found' }
        return { exitCode: 0, stdout: JSON.stringify(visible), stderr: '' }
      }
      if (args[2] === 'create') {
        return createError ? { exitCode: 1, stdout: '', stderr: createError } : { exitCode: 0, stdout: 'created', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  const ctx = new Context()
  const client = { async exec() { return { exitCode: 0, stdout: '', stderr: '' } } } as never
  const rt = new K8sContainerRuntime(ctx, config(), runner, client)
  const ensure = (rt as unknown as {
    ensureSandbox: (t: unknown, s: string) => Promise<{ phase: string; fingerprint?: string }>
  }).ensureSandbox.bind(rt)
  return { ensure, calls, spec: () => createdSpec }
}

interface PodSpecShape { metadata: { annotations: Record<string, string> } }

const parseSpec = (spec: string): PodSpecShape => JSON.parse(spec) as PodSpecShape

const fingerprintOf = (spec: string) => {
  try { return parseSpec(spec).metadata.annotations['dsh.dev/spec-fingerprint'] } catch { return undefined }
}

const runningPod = (fingerprint: string | undefined) => ({
  metadata: { name: 'x', annotations: { 'dsh.dev/spec-fingerprint': fingerprint } },
  status: { phase: 'Running', podIP: '10.0.0.9', conditions: [{ type: 'Ready', status: 'True' }] },
})

const deleted = (calls: string[][]) => calls.some(c => c[2] === 'delete')

describe('sandbox ownership across host instances', () => {
  it('adopts a running sandbox built from this host spec instead of replacing it', async () => {
    // Learn the fingerprint this host would stamp, the way a first instance does.
    const first = harness(null)
    await first.ensure(TENANT, 'investigator-1').catch(() => undefined)
    const fp = parseSpec(first.spec()).metadata.annotations['dsh.dev/spec-fingerprint']
    expect(fp).toBeTruthy()

    // A second instance serving the same (tenant, user) must reuse the running
    // sandbox: deleting it would tear down another instance's in-flight work.
    const { ensure, calls } = harness(runningPod(fp))
    const status = await ensure(TENANT, 'investigator-1')
    expect(status.phase).toBe('Running')
    expect(deleted(calls)).toBe(false)
  }, 30000)

  it('refuses to replace a sandbox built from a different spec', async () => {
    const { ensure, calls } = harness(runningPod('stale-fingerprint'))
    await expect(ensure(TENANT, 'investigator-1')).rejects.toThrow(/different spec/)
    expect(deleted(calls)).toBe(false)
  })

  it('adopts the winner when two instances create the same sandbox concurrently', async () => {
    const { ensure } = harness(null, 'Error from server (AlreadyExists): pods already exists')
    await expect(ensure(TENANT, 'investigator-1')).resolves.toMatchObject({ phase: 'Running' })
  }, 30000)

  it('reuses a resolved sandbox handle instead of reading the cluster on every call', async () => {
    const first = harness(null)
    await first.ensure(TENANT, 'investigator-1').catch(() => undefined)
    const fp = parseSpec(first.spec()).metadata.annotations['dsh.dev/spec-fingerprint']
    const { ensure, calls } = harness(runningPod(fp))
    const reads = () => calls.filter(c => c[2] === 'get' && c[3] === 'pod').length
    await ensure(TENANT, 'investigator-1')
    const afterFirst = reads()
    await ensure(TENANT, 'investigator-1')
    // Every tool call resolves a sandbox; doing that from the cluster each time
    // costs a kubectl process and an API-server round trip per call.
    expect(reads()).toBe(afterFirst)
  }, 30000)

  it('coalesces concurrent resolutions of one sandbox into a single cluster read', async () => {
    const first = harness(null)
    await first.ensure(TENANT, 'investigator-1').catch(() => undefined)
    const fp = parseSpec(first.spec()).metadata.annotations['dsh.dev/spec-fingerprint']
    const { ensure, calls } = harness(runningPod(fp))
    // Several sessions of one user ask at once: they must share one resolution,
    // not each drive their own against the same sandbox. The baseline is what a
    // single caller costs (one status read plus the readiness poll).
    const single = harness(runningPod(fp))
    await single.ensure(TENANT, 'investigator-1')
    const baseline = single.calls.filter(c => c[2] === 'get' && c[3] === 'pod').length

    await Promise.all([ensure(TENANT, 'investigator-1'), ensure(TENANT, 'investigator-1'), ensure(TENANT, 'investigator-1')])
    expect(calls.filter(c => c[2] === 'get' && c[3] === 'pod')).toHaveLength(baseline)
  }, 30000)
})
