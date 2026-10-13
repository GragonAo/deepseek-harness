import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContainerCommandResult, ContainerPtyOutcome } from '@deepseek-ai/dsh-container'
import type { ContainerPtyRunner, ContainerPtyTransport } from '@deepseek-ai/dsh-container-transport'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { DockerContainerRuntime } from '../src/index.ts'
import type { Config, DockerRunner, ToolExecClient } from '../src/index.ts'
import { hostPathProbe } from '../src/python-env.ts'
import type { HostPathProbe } from '../src/python-env.ts'
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

/** The same tenant without a `toolsRoot` on its record, for the /tools fallback rule. */
function tenantWithoutTools(): Tenant {
  const record = tenant('acme')
  return { id: record.id, name: record.name, dataRoot: record.dataRoot, workspaceRoot: record.workspaceRoot }
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
    // The identity probe of an interactive session reports a live session and its
    // leading process group; every other request succeeds with a fixed body.
    if (req.argv[0] === 'sh' && req.argv.join(' ').includes('DSH_PTY_MEMBER')) {
      return { exitCode: 0, stdout: 'DSH_PTY_MEMBER 42 42\nDSH_PTY_LEADER 42 42\n', stderr: '' }
    }
    return { exitCode: 0, stdout: 'ok', stderr: '' }
  }
}

/**
 * A probe reporting every path as an existing directory. These tests configure
 * mount sources no host has; a start must find them present, so what the
 * assertions read is the run arguments rather than the missing-source failure.
 */
const presentProbe: HostPathProbe = {
  isDirectory: () => true,
  isFile: () => false,
  readdir: () => [],
}

/** Await a promise and return its rejection, failing the test if it resolves instead. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error: unknown) {
    return error as Error
  }
  throw new Error('expected the call to reject')
}

function mount(
  runner: DockerRunner,
  client: ToolExecClient,
  config: Config = { runtime: 'docker' },
  probe: HostPathProbe = presentProbe,
  pty?: ContainerPtyRunner,
): DockerContainerRuntime {
  return new DockerContainerRuntime(new Context(), config, runner, client, probe, pty)
}

/**
 * A host filesystem probe over an in-memory tree: exactly the directories and
 * files it is given, and nothing else. `readdir` derives the entry names
 * directly under a directory from those directories, which is all the Python
 * environment resolution asks of it.
 */
class FakeProbe implements HostPathProbe {
  private readonly directories: readonly string[]
  private readonly files: readonly string[]

  constructor(directories: readonly string[], files: readonly string[] = []) {
    this.directories = directories
    this.files = files
  }

  isDirectory(path: string): boolean {
    return this.directories.includes(path)
  }

  isFile(path: string): boolean {
    return this.files.includes(path)
  }

  readdir(path: string): string[] {
    const prefix = `${path}/`
    return [...new Set(this.directories
      .filter(directory => directory.startsWith(prefix))
      .map(directory => directory.slice(prefix.length).split('/')[0] ?? ''))]
  }
}

/** The host directories one (tenant, user)'s sandbox mounts in these tests. */
const SANDBOX_MOUNT_SOURCES = [
  '/workspace/acme/users/user-1',
  '/workspace/acme/shared',
  '/workspace/acme/shared/skills',
  '/tools/acme',
] as const

/**
 * A {@link FakeProbe} over `directories` plus the sandbox's own mount sources, for
 * a test that models one aspect of the host (the Python environment's layout) and
 * leaves the mounts alone.
 * @param directories - the directories the host has beyond the mounts.
 * @param files - the regular files the host has.
 * @returns the probe.
 */
function probeWithMounts(directories: readonly string[], files: readonly string[] = []): FakeProbe {
  return new FakeProbe([...directories, ...SANDBOX_MOUNT_SOURCES], files)
}

/**
 * The interactive terminal seam: it records what the provider asked the host to
 * launch and answers the session handshake, which is all the container side of
 * an interactive session can be asserted without a browser-side TTY.
 */
class FakePtyRunner implements ContainerPtyRunner {
  readonly starts: { args: readonly string[]; rows: number; cols: number; graceMs: number }[] = []

  async start(args: readonly string[], spec: { rows: number; cols: number; graceMs: number }): Promise<ContainerPtyTransport> {
    this.starts.push({ args, ...spec })
    const listeners = new Set<(data: string) => void>()
    return {
      pid: 1,
      done: new Promise<ContainerPtyOutcome>(() => {}),
      onData: (listener: (data: string) => void): (() => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      async write(data: string): Promise<void> {
        if (!data.includes('DSH_PTY_SESSION')) return
        for (const listener of listeners) listener('DSH_PTY_SESSION 42\r\nbash-5.2# ')
      },
      async terminate(): Promise<void> {},
    }
  }
}

/**
 * A runner whose CLI calls never return while `wedged`, modelling a container
 * daemon that accepted the request and stopped answering. It ignores the signal
 * a real `docker` child would be killed by, so only the provider's own deadline
 * can end the wait.
 */
class WedgedRunner implements DockerRunner {
  private readonly inner = new FakeRunner()
  wedged = true
  calls = 0
  starts = 0
  /** 除启动收尸的那次 `ps` 之外的调用次数：那些才是「碰了某个容器」。 */
  containerCalls = 0

  async run(args: readonly string[], opts?: { stdin?: string; signal?: AbortSignal }): Promise<ContainerCommandResult> {
    this.calls += 1
    if (args[0] !== 'ps') this.containerCalls += 1
    if (this.wedged) return await new Promise<ContainerCommandResult>(() => {})
    if (args[0] === 'run') this.starts += 1
    return await this.inner.run(args, opts)
  }
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

  it('opens an interactive session with a TTY on the tenant\'s own container', async () => {
    const runner = new FakeRunner()
    const client = new FakeClient()
    const pty = new FakePtyRunner()
    const runtime = mount(runner, client, { runtime: 'docker' }, presentProbe, pty)
    const session = await scoped(tenant('acme'), 'user-1', () =>
      runtime.openPty({ command: 'bash', rows: 24, cols: 80, maxOutputBytes: 4_096, disposeGraceMs: 500 }))

    const [started] = pty.starts
    expect(started?.args.slice(0, 3)).toEqual(['exec', '-i', '-t'])
    // The container is the one this tenant and user own, under their partition names.
    expect(started?.args[3]).toMatch(/^dsh-tenant_acme_.+-user_user_1_.+$/)
    expect(started?.args.slice(4)).toEqual(['bash'])
    expect(started).toMatchObject({ rows: 24, cols: 80, graceMs: 500 })
    // The session's identity comes from the sandbox's own process table, over the
    // same tool-exec client every one-shot command uses.
    expect(session.pid).toBe(42)
    expect(client.requests.some(request => request.req.argv.join(' ').includes('DSH_PTY_MEMBER'))).toBe(true)
  })

  it('承认为可写时案件共享与用户全局目录不再只读，技能层始终只读', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), {
      runtime: 'docker', usersRoot: '/users', sharedReadOnly: false, usersReadOnly: false,
    })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('/workspace/acme/shared:/shared')
    expect(runCall).not.toContain('/workspace/acme/shared:/shared:ro')
    expect(runCall).toContain('/users/user-1:/global')
    expect(runCall).not.toContain('/users/user-1:/global:ro')
    expect(runCall).toContain('/workspace/acme/shared/skills:/opt/data/skills/case:ro')
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
    expect(runCall).toContain('/workspace/acme/shared:/shared:ro')
    expect(runCall).toContain('/users/user-1:/global:ro')
    expect(runCall).toContain('/tools/acme:/tools:ro')
    expect(runCall).toContain('/opt/.dsh/system:/opt/.dsh/system:ro')
    // The case-shared skill tier's own directory must resolve in the sandbox: a skill
    // body resolves relative paths against that base directory.
    expect(runCall).toContain('/workspace/acme/shared/skills:/workspace/acme/shared/skills:ro')
    // The same three tiers again under the root the case scripts enumerate: a mount carries
    // one source to one path, so each tier keeps its own subdirectory there.
    expect(runCall).toContain('/workspace/acme/shared/skills:/opt/data/skills/case:ro')
    expect(runCall).toContain('/users/user-1/skills:/opt/data/skills/user-global:ro')
    expect(runCall).toContain('/opt/.dsh/system/skills:/opt/data/skills/system:ro')
    expect(runCall).toContain('dsh-tool-exec:latest')
    // The image's entrypoint takes the port as its first argument, so the image
    // name is followed by the port the provider publishes and dials.
    expect(runCall?.slice(-2)).toEqual(['dsh-tool-exec:latest', '8642'])
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

  it('publishes a configured container port and hands the same port to the image entrypoint', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', toolExecPort: 9000 })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('127.0.0.1::9000')
    expect(runCall?.slice(-2)).toEqual(['dsh-tool-exec:latest', '9000'])
    expect(runner.calls.find(c => c[0] === 'port')).toEqual(['port', expect.any(String), '9000'])
  })

  it('refuses to start when a bind-mount source is missing, naming the path, its mount point, and the (tenant, member)', async () => {
    const runner = new FakeRunner()
    // Every source is on this host except the subject's case workspace, which is
    // what a directory removed after admission looks like.
    const probe: HostPathProbe = {
      isDirectory: path => path !== '/workspace/acme/users/user-1',
      isFile: () => false,
      readdir: () => [],
    }
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', usersRoot: '/users' }, probe)
    const error = await rejection(scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'])))
    expect(error.message).toContain("bind-mount source '/workspace/acme/users/user-1' (for '/workspace') is missing on this host")
    // The directory to create belongs to a (tenant, member) pair, so both are named.
    expect(error.message).toContain("tenant 'acme' member 'user-1'")
    // The failure is this check, not a container CLI error: nothing ran, and no
    // same-name container was cleared either. The startup sweep's `ps` does not
    // touch any container, so it is not one of these calls.
    expect(runner.calls.filter(call => call[0] !== 'ps')).toHaveLength(0)
  })

  it('names every missing bind-mount source in one failure', async () => {
    const runner = new FakeRunner()
    // A host that has none of the sources: the case workspace, the case-shared tree,
    // the case-shared skill view, the user-global root, the system tree, and the
    // tenant's tools root are all absent.
    const absent: HostPathProbe = { isDirectory: () => false, isFile: () => false, readdir: () => [] }
    const runtime = mount(
      runner,
      new FakeClient(),
      { runtime: 'docker', usersRoot: '/users', systemRoot: '/opt/.dsh/system' },
      absent,
    )
    const error = await rejection(scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'])))
    for (const source of [
      "'/workspace/acme/users/user-1' (for '/workspace')",
      "'/workspace/acme/shared' (for '/shared')",
      "'/workspace/acme/shared/skills' (for '/workspace/acme/shared/skills')",
      "'/users/user-1' (for '/global')",
      "'/opt/.dsh/system' (for '/opt/.dsh/system')",
      "'/tools/acme' (for '/tools')",
    ]) {
      expect(error.message).toContain(source)
    }
    expect(runner.calls.filter(call => call[0] !== 'ps')).toHaveLength(0)
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
    expect(runCall).toContain('/workspace/acme/shared:/shared:ro')
    expect(runCall).not.toContain('/global')
  })

  it('replaces a sandbox whose exec fails and retries the request once', async () => {
    const runner = new FakeRunner()
    let failed = false
    const client: ToolExecClient = {
      async exec(_baseUrl: string, req: ToolExecRequest): Promise<ToolExecResult> {
        if (req.argv[0] === 'echo' && !failed) {
          failed = true
          throw new TypeError('fetch failed')
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      },
    }
    const runtime = mount(runner, client)
    const result = await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    expect(result.stdout).toBe('ok')
    expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(2)
    expect(runner.calls.some(c => c[0] === 'rm' && c[1] === '-f')).toBe(true)
  })

  it('does not replace the sandbox when the caller aborted the exec', async () => {
    const runner = new FakeRunner()
    const controller = new AbortController()
    const client: ToolExecClient = {
      async exec(_baseUrl: string, req: ToolExecRequest): Promise<ToolExecResult> {
        if (req.argv[0] === 'echo') {
          controller.abort()
          throw new TypeError('fetch failed')
        }
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      },
    }
    const runtime = mount(runner, client)
    await expect(scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'], { signal: controller.signal })))
      .rejects.toThrow('fetch failed')
    expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(1)
  })

  it('omits the system skill mount when no systemRoot is configured', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).not.toContain('/opt/.dsh/system')
  })

  it('mounts the configured Python environment read-only and points the sandbox at it', async () => {
    const runner = new FakeRunner()
    const runtime = mount(
      runner,
      new FakeClient(),
      { runtime: 'docker', pythonRoot: '/opt/.dsh/pyenv' },
      probeWithMounts(
        [
          '/opt/.dsh/pyenv',
          '/opt/.dsh/pyenv/bin',
          '/opt/.dsh/pyenv/lib/python3.11/site-packages',
          // A second version directory holding no packages, and a `lib` entry that
          // is no version directory: neither contributes a PYTHONPATH entry.
          '/opt/.dsh/pyenv/lib/python3.12',
          '/opt/.dsh/pyenv/lib/site-packages',
        ],
        ['/opt/.dsh/pyenv/pyvenv.cfg'],
      ),
    )
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('/opt/.dsh/pyenv:/opt/.dsh/pyenv:ro')
    expect(runCall).toContain('VIRTUAL_ENV=/opt/.dsh/pyenv')
    expect(runCall).toContain('PYTHONPATH=/opt/.dsh/pyenv/lib/python3.11/site-packages')
    // `docker run -e PATH=…` replaces the image's PATH, so the mounted bin
    // directory is prepended to the image's own value, not to the host's.
    const pathArg = runCall?.find(arg => arg.startsWith('PATH='))
    expect(pathArg?.startsWith('PATH=/opt/.dsh/pyenv/bin:')).toBe(true)
    expect(pathArg).not.toBe('PATH=/opt/.dsh/pyenv/bin:')
  })

  it('mounts no Python environment and sets no Python variable when pythonRoot is absent', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).not.toContain('/opt/.dsh/pyenv')
    expect(runCall?.some(arg => /^(?:PATH|VIRTUAL_ENV|PYTHONPATH)=/u.test(arg))).toBe(false)
  })

  it('prepends PATH alone for a mounted directory that is no virtual environment', async () => {
    const runner = new FakeRunner()
    const runtime = mount(
      runner,
      new FakeClient(),
      { runtime: 'docker', pythonRoot: '/opt/.dsh/pyenv' },
      probeWithMounts(['/opt/.dsh/pyenv', '/opt/.dsh/pyenv/bin']),
    )
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('/opt/.dsh/pyenv:/opt/.dsh/pyenv:ro')
    expect(runCall?.find(arg => arg.startsWith('PATH='))?.startsWith('PATH=/opt/.dsh/pyenv/bin:')).toBe(true)
    expect(runCall?.some(arg => arg.startsWith('VIRTUAL_ENV='))).toBe(false)
    expect(runCall?.some(arg => arg.startsWith('PYTHONPATH='))).toBe(false)
  })

  it('refuses to load when the configured pythonRoot is not a directory this host can read', () => {
    // Configured but invisible: mounting it would produce an empty directory and
    // no Python variable at all, so the load fails instead of degrading.
    expect(() => mount(
      new FakeRunner(),
      new FakeClient(),
      { runtime: 'docker', pythonRoot: '/opt/.dsh/pyenv' },
      new FakeProbe([]),
    )).toThrow(/pythonRoot '\/opt\/\.dsh\/pyenv' is not a directory this process can read/u)
    // A path that exists as a file is no more usable than a missing one.
    expect(() => mount(
      new FakeRunner(),
      new FakeClient(),
      { runtime: 'docker', pythonRoot: '/opt/.dsh/pyenv' },
      new FakeProbe([], ['/opt/.dsh/pyenv']),
    )).toThrow(/\/opt\/\.dsh\/pyenv/u)
  })

  it('refuses to load when the configured pythonRoot holds no Python environment', () => {
    // An existing directory with none of the three markers configures nothing,
    // and Docker turns a missing bind-mount source into exactly this, so the
    // load fails instead of starting a sandbox with no interpreter.
    expect(() => mount(
      new FakeRunner(),
      new FakeClient(),
      { runtime: 'docker', pythonRoot: '/opt/.dsh/pyenv' },
      new FakeProbe(['/opt/.dsh/pyenv']),
    )).toThrow(/pythonRoot '\/opt\/\.dsh\/pyenv' is a directory holding no Python environment/u)
    // A directory with something else in it is no environment either.
    expect(() => mount(
      new FakeRunner(),
      new FakeClient(),
      { runtime: 'docker', pythonRoot: '/opt/.dsh/pyenv' },
      new FakeProbe(['/opt/.dsh/pyenv', '/opt/.dsh/pyenv/wheels']),
    )).toThrow(/is a directory holding no Python environment/u)
  })

  it('restates a configured toolExecImagePath when the mounted bin directory is prepended', async () => {
    const runner = new FakeRunner()
    const runtime = mount(
      runner,
      new FakeClient(),
      { runtime: 'docker', pythonRoot: '/opt/.dsh/pyenv', toolExecImagePath: '/opt/node/bin:/usr/bin:/bin' },
      probeWithMounts(['/opt/.dsh/pyenv', '/opt/.dsh/pyenv/bin']),
    )
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('PATH=/opt/.dsh/pyenv/bin:/opt/node/bin:/usr/bin:/bin')
  })

  it('tells the sandbox which case and subject it belongs to', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    const runCall = runner.calls.find(c => c[0] === 'run')
    expect(runCall).toContain('DSH_CASE_ID=acme')
    expect(runCall).toContain('DSH_TENANT_ID=acme')
    expect(runCall).toContain('DSH_USER_ID=user-1')
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

  it('hands the idle budget to the container and collects what a container left behind', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', idleTimeoutMs: 20 })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('a', []))
    // 空闲由容器自己判定：宿主看不见别的副本对这个沙箱的使用，而每一个请求都要到达容器。
    expect(runner.calls.find(call => call[0] === 'run')).toContain('DSH_TOOL_EXEC_IDLE_MS=20')
    // 启动时收一次尸，只按标签收已经退出的容器：Running 的可能是另一个副本正在用的沙箱。
    expect(runner.calls.find(call => call[0] === 'ps'))
      .toEqual(['ps', '-a', '--filter', 'label=dsh.dev/managed', '--filter', 'status=exited', '-q'])
  })

  it('hands the output bound to the container, which enforces it itself', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', maxOutputBytes: 4096 })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('a', []))
    // 原始流是容器先攒满、宿主才轮得到加界的：上界不注入容器就等于没设。
    expect(runner.calls.find(call => call[0] === 'run')).toContain('DSH_TOOL_EXEC_MAX_OUTPUT_BYTES=4096')
  })

  it('injects the default output bound when the config leaves it unset', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker' })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('a', []))
    // 与空闲预算不同，这条上界总有一个值：省略配置不等于「不加界」。
    expect(runner.calls.find(call => call[0] === 'run')).toContain('DSH_TOOL_EXEC_MAX_OUTPUT_BYTES=67108864')
  })

  it('takes /tools from the configured root when the tenant record has none', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', toolsRoot: '/shared-tools' })
    // The same rule as container-k8s: the tenant's own toolsRoot wins, and only a
    // tenant record without one falls back to the configured root.
    await scoped(tenantWithoutTools(), 'user-1', () => runtime.exec('a', []))
    expect(runner.calls.find(c => c[0] === 'run')).toContain('/shared-tools:/tools:ro')
  })

  it('mounts no /tools at all when neither the tenant record nor the configuration names a root', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient())
    await scoped(tenantWithoutTools(), 'user-1', () => runtime.exec('a', []))
    expect(runner.calls.find(c => c[0] === 'run')?.some(argument => argument.includes(':/tools'))).toBe(false)
  })

  it('re-confirms a cached container with `docker port` once its handle TTL expired', async () => {
    const runner = new FakeRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', sandboxCacheTtlMs: 20 })
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('a', []))
    expect(runner.calls.filter(c => c[0] === 'port')).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 60))
    await scoped(tenant('acme'), 'user-1', () => runtime.exec('b', []))
    // Expiry re-reads the published port; it does not rebuild a container that is
    // still running.
    expect(runner.calls.filter(c => c[0] === 'port')).toHaveLength(2)
    expect(runner.calls.filter(c => c[0] === 'run')).toHaveLength(1)
  })
  it('bounds one container CLI call that never returns', async () => {
    const runner: DockerRunner = {
      // Models the production runner: the deadline kills the CLI child, so the
      // await settles with the kill instead of hanging.
      run: (_args, opts) => new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => { reject(new Error('killed')) }, { once: true })
      }),
    }
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', cliTimeoutMs: 20, startTimeoutMs: 5_000 })
    await expect(scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'])))
      .rejects.toThrow('did not finish within 20ms')
  })

  it('fails a start whose CLI never returns, and starts fresh on the next exec', async () => {
    const runner = new WedgedRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', cliTimeoutMs: 20, startTimeoutMs: 60 })
    await expect(scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'])))
      .rejects.toThrow('did not finish within 60ms')
    expect(runner.starts).toBe(0)
    // The failed start left no cached promise: the next exec runs the CLI again
    // instead of joining the same unsettled start for the rest of the host's life.
    runner.wedged = false
    const result = await scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi']))
    expect(result.exitCode).toBe(0)
    expect(runner.starts).toBe(1)
  })

  it('bounds a tool-exec round trip that never answers', async () => {
    const client: ToolExecClient = {
      exec: (_baseUrl, req, signal) => req.argv[0] === 'sh'
        ? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
        // Models `fetch` against a server that took the request and stopped
        // answering: the request settles only when its signal aborts.
        : new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('The operation was aborted')) }, { once: true })
        }),
    }
    const runtime = mount(new FakeRunner(), client, { runtime: 'docker', transportTimeoutMs: 20 })
    await expect(scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'])))
      .rejects.toThrow('did not answer within 20ms')
  })

  it('fails an already-aborted call before it starts a container', async () => {
    const runner = new WedgedRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', startTimeoutMs: 5_000 })
    const controller = new AbortController()
    controller.abort()
    await expect(scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'], { signal: controller.signal })))
      .rejects.toThrow('aborted')
    // 取消要发生在容器之前：那次启动收尸的 `ps` 不算碰容器。
    expect(runner.containerCalls).toBe(0)
  })

  it('escapes a start that is still pending when the caller aborts', async () => {
    const runner = new WedgedRunner()
    const runtime = mount(runner, new FakeClient(), { runtime: 'docker', startTimeoutMs: 5_000 })
    const controller = new AbortController()
    const pending = scoped(tenant('acme'), 'user-1', () => runtime.exec('echo', ['hi'], { signal: controller.signal }))
    controller.abort()
    // The shared start outlives this caller, but the caller does not wait for it.
    await expect(pending).rejects.toThrow('aborted')
    expect(runner.starts).toBe(0)
  })
})

describe('hostPathProbe', () => {
  it('reports directories, files, and entry names, and nothing for a path it cannot read', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-python-env-'))
    try {
      mkdirSync(join(root, 'bin'))
      writeFileSync(join(root, 'pyvenv.cfg'), 'home = /usr/bin\n')
      expect(hostPathProbe.isDirectory(join(root, 'bin'))).toBe(true)
      expect(hostPathProbe.isDirectory(join(root, 'pyvenv.cfg'))).toBe(false)
      expect(hostPathProbe.isFile(join(root, 'pyvenv.cfg'))).toBe(true)
      expect(hostPathProbe.isFile(join(root, 'bin'))).toBe(false)
      expect(hostPathProbe.isFile(join(root, 'missing'))).toBe(false)
      expect(hostPathProbe.readdir(root).sort()).toEqual(['bin', 'pyvenv.cfg'])
      // Absent and non-directory alike yield no candidate.
      expect(hostPathProbe.readdir(join(root, 'missing'))).toEqual([])
      expect(hostPathProbe.readdir(join(root, 'pyvenv.cfg'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
