import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContainerCommandResult } from '@deepseek-ai/dsh-container'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { DockerContainerRuntime } from '../src/index.ts'
import type { Config, DockerRunner, ToolExecClient } from '../src/index.ts'
import type { ToolExecRequest, ToolExecResult } from '../src/tool-exec.ts'

function tenant(id: string): Tenant {
  return {
    id: TenantId(id),
    name: id,
    dataRoot: `/data/${id}`,
    workspaceRoot: `/workspace/${id}`,
    toolsRoot: `/tools/${id}`,
  }
}

/** Enter the ambient (tenant, user) scope most request paths run under. */
function scoped<T>(t: Tenant, user: string, fn: () => T): T {
  return runWithTenant(t, () => runWithUser(UserId(user), fn))
}

class FakeRunner implements DockerRunner {
  readonly calls: string[][] = []
  async run(args: readonly string[], _opts?: { stdin?: string; signal?: AbortSignal }): Promise<ContainerCommandResult> {
    this.calls.push([...args])
    if (args[0] === 'run') {
      const nameIndex = args.indexOf('--name')
      return { exitCode: 0, stdout: args[nameIndex + 1] ?? 'missing', stderr: '' }
    }
    if (args[0] === 'port') {
      return { exitCode: 0, stdout: '127.0.0.1:43210', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

class FakeClient implements ToolExecClient {
  readonly requests: { baseUrl: string; req: ToolExecRequest }[] = []
  async exec(baseUrl: string, req: ToolExecRequest): Promise<ToolExecResult> {
    this.requests.push({ baseUrl, req })
    return { exitCode: 0, stdout: 'ok', stderr: '' }
  }
}

function mount(runner: FakeRunner, client: ToolExecClient, config: Config = { runtime: 'docker' }): DockerContainerRuntime {
  return new DockerContainerRuntime(new Context(), config, runner, client)
}

describe('DockerContainerRuntime', () => {
  it('fails closed when no tenant is in scope', async () => {
    const runtime = mount(new FakeRunner(), new FakeClient())
    await expect(runtime.exec('echo', ['hi'])).rejects.toMatchObject({ code: 'NO_TENANT_IN_SCOPE' })
  })

  it('fails closed when a tenant but no user is in scope', async () => {
    const runtime = mount(new FakeRunner(), new FakeClient())
    await expect(runWithTenant(tenant('acme'), () => runtime.exec('echo', ['hi'])))
      .rejects.toMatchObject({ code: 'NO_USER_IN_SCOPE' })
  })

  it('starts a tool-exec container with the three-layer mounts after publishing its loopback port, then POSTs /exec', async () => {
    const runner = new FakeRunner()
    const client = new FakeClient()
    const runtime = mount(runner, client, { runtime: 'docker', usersRoot: '/users', systemRoot: '/opt/.dsh/system' })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('-p')
    expect(runCall).toContain('127.0.0.1::8642')
    expect(runCall).toContain('--add-host')
    expect(runCall).toContain('host.docker.internal:host-gateway')
    // The 3 case/user layers plus the read-only tool layer.
    expect(runCall).toContain('/workspace/acme/users/user-1:/workspace')
    expect(runCall).toContain('/workspace/acme/shared:/shared')
    expect(runCall).toContain('/users/user-1:/global')
    expect(runCall).toContain('/tools/acme:/tools:ro')
    expect(runCall).toContain('/opt/.dsh/system:/opt/.dsh/system:ro')
    expect(runCall).toContain('dsh-tool-exec:latest')
    expect(runCall).not.toContain('tail')
    const name = runCall?.[runCall?.indexOf('--name') + 1]
    expect(name).toMatch(/^dsh-tenant_acme_[0-9a-f]{12}-user_user_1_[0-9a-f]{12}$/)
    const portCall = runner.calls.find(c => c[0] === 'port')
    expect(portCall).toEqual(['port', name, '8642'])
    expect(runner.calls.some(c => c[0] === 'exec')).toBe(false)
    expect(client.requests).toEqual([
      { baseUrl: 'http://127.0.0.1:43210', req: { argv: ['sh', '-c', 'true'] } },
      { baseUrl: 'http://127.0.0.1:43210', req: { argv: ['echo', 'hi'] } },
    ])
  })

  it('publishes the tool-exec port on, and dials it at, the configured host addresses', async () => {
    const runner = new FakeRunner()
    const client = new FakeClient()
    const runtime = mount(runner, client, {
      runtime: 'docker',
      publishHost: '172.17.0.1',
      connectHost: 'host.docker.internal',
    })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('172.17.0.1::8642')
    expect(client.requests.map(request => request.baseUrl)).toEqual([
      'http://host.docker.internal:43210',
      'http://host.docker.internal:43210',
    ])
  })

  it('caps memory (with swap) and CPU when ceilings are configured, and passes neither otherwise', async () => {
    const capped = new FakeRunner()
    await scoped(tenant('acme'), 'user-1', () =>
      mount(capped, new FakeClient(), { runtime: 'docker', memoryLimit: '2g', cpuLimit: 2 })
        .exec('echo', ['hi']))
    const cappedRun = capped.calls.find(c => c[0] === 'run')
    expect(cappedRun).toContain('--memory')
    expect(cappedRun).toContain('2g')
    // Swap capped at the memory limit, so exceeding it dies in place instead of swapping the host.
    expect(cappedRun).toContain('--memory-swap')
    expect(cappedRun?.[cappedRun.indexOf('--memory-swap') + 1]).toBe('2g')
    expect(cappedRun).toContain('--cpus')
    expect(cappedRun?.[cappedRun.indexOf('--cpus') + 1]).toBe('2')

    const uncapped = new FakeRunner()
    await scoped(tenant('acme'), 'user-1', () => mount(uncapped, new FakeClient()).exec('echo', ['hi']))
    const plainRun = uncapped.calls.find(c => c[0] === 'run')
    expect(plainRun).not.toContain('--memory')
    expect(plainRun).not.toContain('--cpus')
  })

  it('omits the /global mount when no usersRoot is configured', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('/workspace/acme/users/user-1:/workspace')
    expect(runCall).toContain('/workspace/acme/shared:/shared')
    expect(runCall).not.toContain('/global')
  })

  it('omits the system skill mount when no systemRoot is configured', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).not.toContain('/opt/.dsh/system')
  })

  it('waits for the tool-exec server to answer before the first exec', async () => {
    const runner = new FakeRunner()
    let attempts = 0
    const client: ToolExecClient = {
      async exec(_baseUrl: string, _req: ToolExecRequest): Promise<ToolExecResult> {
        attempts += 1
        if (attempts === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:43210')
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      },
    }
    const runtime = mount(runner, client)
    const result = await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    expect(result.exitCode).toBe(0)
    // Refused readiness probe, successful probe, then the actual command.
    expect(attempts).toBe(3)
  })

  it('reuses one container per (tenant, user)', async () => {
    const runner = new FakeRunner()
    const client = new FakeClient()
    const runtime = mount(runner, client)
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('a', []))
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('b', []))
    expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(1)
    expect(client.requests).toHaveLength(3)
    expect(client.requests[1]?.req.argv).toEqual(['a'])
    expect(client.requests[2]?.req.argv).toEqual(['b'])
  })

  it('isolates each tenant and each user in its own container', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('a', []))
    await scoped(tenant('globex'), 'user-1', () => runtime.exec('a', []))
    await scoped(tenant('acme'), 'user-2', () => runtime.exec('a', []))
    const runs = runner.calls.filter(c => c[0] === 'run')
    expect(runs).toHaveLength(3)
    expect(runs.some(c => c.includes('/workspace/acme/users/user-1:/workspace'))).toBe(true)
    expect(runs.some(c => c.includes('/workspace/globex/users/user-1:/workspace'))).toBe(true)
    expect(runs.some(c => c.includes('/workspace/acme/users/user-2:/workspace'))).toBe(true)
    // Three distinct container names.
    expect(new Set(runs.map(c => c[c.indexOf('--name') + 1])).size).toBe(3)
  })

  it('opts a no-egress tenant into the none network', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    const noEgress = { ...tenant('acme'), network: 'none' as const }
    await scoped(noEgress, 'user-1', () => runtime.exec('a', []))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('--network')
    expect(runCall).toContain('none')
  })

  it('reaps an idle container and lazily restarts on next use', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', idleTimeoutMs: 20 })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('a', []))
    expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(1)
    // One `rm -f` clears the same-name stale container before the first start.
    expect(runner.calls.filter(c => c[0] === 'rm' && c[1] === '-f')).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 60))
    // The idle reap fires the second `rm -f` on the same stable name.
    expect(runner.calls.filter(c => c[0] === 'rm' && c[1] === '-f')).toHaveLength(2)
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('b', []))
    expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(2)
    expect(runner.calls.filter(c => c[0] === 'rm' && c[1] === '-f')).toHaveLength(3)
  })
})
