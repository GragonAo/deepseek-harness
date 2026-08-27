/**
 * Local Docker/Podman provider for the container-runtime capability seam
 * (`ctx.containerRuntime`). Starts one small tool-exec server container per
 * (tenant, user) — the case workspace bind-mounted at `/workspace`, the
 * case-shared directory at `/shared`, the subject's cross-case global directory
 * at `/global`, and tooling at `/tools` (read-only) — publishes its HTTP port
 * on the host loopback, and runs commands by POSTing to that server (ip+host).
 * The container is started lazily on the subject's first tool call and never
 * pays a pre-warmed cold-start it could not honor (a per-user container has no
 * user to warm at boot); its stable name means a non-graceful host shutdown
 * cannot orphan an older execution world (the next start clears the same-name
 * container first). Idle containers are reaped after `idleTimeoutMs`, and the
 * execution world itself is stateless: everything a tenant and user own lives
 * on its mounts, never in the container.
 * @module @deepseek-ai/dsh-container-docker
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type { ContainerCommandResult, ContainerExecOptions } from '@deepseek-ai/dsh-container'
import { requireTenant, requireUser, tenantPartitionName, userPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant, UserId } from '@deepseek-ai/dsh-tenant'
import { cliRunner } from './runner.ts'
import type { DockerRunner } from './runner.ts'
import { execToolCommand } from './tool-exec.ts'
import type { ToolExecRequest, ToolExecResult } from './tool-exec.ts'

export { cliRunner } from './runner.ts'
export type { DockerRunner } from './runner.ts'
export { execToolCommand, listenToolExecServer } from './tool-exec.ts'
export type { ListeningToolExecServer, ToolExecRequest, ToolExecResult } from './tool-exec.ts'

/**
 * Tool-exec HTTP client seam (production: `fetch` to the published loopback
 * port; tests inject a recorder).
 */
export interface ToolExecClient {
  /**
   * POST one command to the tenant's tool-exec server.
   * @param baseUrl - the server's loopback address with port.
   * @param req - the argument vector and optional stdin/env/cwd.
   * @param signal - optional cancellation forwarded to the HTTP request.
   * @returns the exit code and captured stdout/stderr.
   */
  exec(baseUrl: string, req: ToolExecRequest, signal?: AbortSignal): Promise<ToolExecResult>
}

/** Live address of one (tenant, user)'s tool-exec server within its container. */
interface TenantRuntime {
  name: string
  port: number
}

/** Plugin configuration. */
export interface Config {
  /** Container CLI binary: `docker` or `podman`. */
  runtime?: 'docker' | 'podman'
  /** Docker network name used unless the tenant opts into `none`. */
  network?: string
  /** In-container tool-exec image run as each (tenant, user)'s execution world. */
  toolExecImage?: string
  /** Container port the tool-exec server binds (published to a random host port). */
  toolExecPort?: number
  /**
   * Host root holding one sub-directory per subject (their cross-case global
   * directory), bind-mounted read-write at `/global`. When omitted the `/global`
   * mount is skipped (single-user deployments without a cross-case directory).
   */
  usersRoot?: string
  /** Milliseconds of exec idleness before the container is reaped. Omit to keep. */
  idleTimeoutMs?: number
}

const PUBLISHED_PORT = /(?:\d+\.\d+\.\d+\.\d+|\[?::\]?):(\d+)/
/** Longest a cold container may take before its tool-exec server answers. */
const TOOL_EXEC_READY_TIMEOUT_MS = 10_000
/** Sleep between tool-exec readiness polls. */
const TOOL_EXEC_READY_POLL_MS = 30

function parsePublishedPort(stdout: string): number | undefined {
  const match = PUBLISHED_PORT.exec(stdout)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** Local Docker/Podman container runtime registered as `ctx.containerRuntime`. */
export class DockerContainerRuntime extends ContainerRuntime {
  static Config: z<Config> = z.object({
    runtime: z.union(['docker', 'podman'] as const).default('docker'),
    network: z.string().default('bridge'),
    toolExecImage: z.string().default('dsh-tool-exec:latest'),
    toolExecPort: z.natural().min(1).default(8642),
    usersRoot: z.string(),
    idleTimeoutMs: z.natural().min(1),
  })

  private readonly runner: DockerRunner
  private readonly client: ToolExecClient
  private readonly network: string
  private readonly toolExecImage: string
  private readonly toolExecPort: number
  private readonly usersRoot: string | undefined
  private readonly idleTimeoutMs: number | undefined
  private readonly tenants = new Map<string, TenantRuntime>()
  private readonly starting = new Map<string, Promise<TenantRuntime>>()
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(ctx: Context, config: Config, runner?: DockerRunner, client?: ToolExecClient) {
    super(ctx)
    this.runner = runner ?? cliRunner(config.runtime ?? 'docker')
    this.client = client ?? { exec: execToolCommand }
    this.network = config.network ?? 'bridge'
    this.toolExecImage = config.toolExecImage ?? 'dsh-tool-exec:latest'
    this.toolExecPort = config.toolExecPort ?? 8642
    this.usersRoot = config.usersRoot
    this.idleTimeoutMs = config.idleTimeoutMs
    ctx.effect(() => async () => {
      for (const timer of this.idleTimers.values()) clearTimeout(timer)
      this.idleTimers.clear()
      const names = new Set([...this.tenants.values()].map(runtime => runtime.name))
      const settled = await Promise.allSettled([...this.starting.values()])
      for (const result of settled) {
        if (result.status === 'fulfilled') names.add(result.value.name)
      }
      await Promise.allSettled([...names].map(name => this.runner.run(['rm', '-f', name])))
    }, 'container-docker teardown')
  }

  async exec(
    command: string,
    args: readonly string[],
    opts?: ContainerExecOptions,
  ): Promise<ContainerCommandResult> {
    const tenant = requireTenant()
    const user = requireUser()
    const key = this.scopeKey(tenant.id, user)
    const runtime = await this.ensure(key, tenant, user)
    this.resetIdle(key)
    const req: ToolExecRequest = { argv: [command, ...args] }
    if (opts?.cwd !== undefined) req.cwd = opts.cwd
    if (opts?.env !== undefined) req.env = { ...opts.env }
    if (opts?.stdin !== undefined) req.stdin = opts.stdin
    return this.client.exec(`http://127.0.0.1:${runtime.port}`, req, opts?.signal)
  }

  private networkFor(tenant: Tenant): string {
    return tenant.network === 'none' ? 'none' : this.network
  }

  /** The in-memory key separating one subject's container within a tenant. */
  private scopeKey(tenantId: Tenant['id'], user: UserId): string {
    return `${tenantId}\u0000${user}`
  }

  private ensure(key: string, tenant: Tenant, user: UserId): Promise<TenantRuntime> {
    const existing = this.tenants.get(key)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = this.starting.get(key)
    if (pending !== undefined) return pending
    const start = this.startContainer(tenant, user)
    this.starting.set(key, start)
    start.then(
      (runtime) => {
        this.tenants.set(key, runtime)
        this.starting.delete(key)
      },
      () => {
        this.starting.delete(key)
      },
    )
    return start
  }

  private async startContainer(tenant: Tenant, user: UserId): Promise<TenantRuntime> {
    // One stable, (tenant, user)-partitioned name, so at most one execution
    // world exists per subject in a tenant at a time: clear any same-name
    // container a non-graceful host shutdown left behind before starting
    // (docker rm -f is a no-op when absent).
    const name = `dsh-${tenantPartitionName(tenant.id)}-${userPartitionName(user)}`
    await this.runner.run(['rm', '-f', name])
    const args = [
      'run', '-d', '--name', name, '--network', this.networkFor(tenant),
      // The host gateway is reachable from the container at this name, so a
      // mounted runtime (code-runtime-container) can bridge its declared
      // host-side bindings back over the loopback HTTP surface it publishes.
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `127.0.0.1::${String(this.toolExecPort)}`,
      '-v', `${tenant.workspaceRoot}/users/${user}:/workspace`,
      '-v', `${tenant.workspaceRoot}/shared:/shared`,
    ]
    if (this.usersRoot !== undefined) {
      args.push('-v', `${this.usersRoot}/${user}:/global`)
    }
    if (tenant.toolsRoot !== undefined) {
      args.push('-v', `${tenant.toolsRoot}:/tools:ro`)
    }
    args.push(this.toolExecImage)
    const result = await this.runner.run(args)
    if (result.exitCode !== 0) {
      throw new Error(`container-docker: '${name}' failed to start (exit ${result.exitCode}): ${result.stderr}`)
    }
    const port = await this.readPublishedPort(name)
    const runtime = { name, port }
    await this.waitReady(runtime)
    return runtime
  }

  private async readPublishedPort(name: string): Promise<number> {
    const result = await this.runner.run(['port', name, String(this.toolExecPort)])
    if (result.exitCode !== 0) {
      throw new Error(`container-docker: cannot read '${name}' host port (exit ${result.exitCode}): ${result.stderr}`)
    }
    const port = parsePublishedPort(result.stdout)
    if (port === undefined) {
      throw new Error(`container-docker: no published host port in '${name}' output: ${result.stdout}`)
    }
    return port
  }

  /**
   * Wait until the started container's tool-exec server answers `POST /exec`.
   * `docker run -d` returns once the container process is created, which is
   * before its in-container Node server has bound the published port, so the
   * first exec after a cold start would otherwise race the bind.
   * @param runtime - the running container's name and published host port.
   * @throws when the server stays unreachable past the readiness timeout.
   */
  private async waitReady(runtime: TenantRuntime): Promise<void> {
    const baseUrl = `http://127.0.0.1:${runtime.port}`
    const deadline = Date.now() + TOOL_EXEC_READY_TIMEOUT_MS
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await this.client.exec(baseUrl, { argv: ['sh', '-c', 'true'] })
        return
      } catch (error: unknown) {
        lastError = error
        await new Promise<void>(resolve => setTimeout(resolve, TOOL_EXEC_READY_POLL_MS))
      }
    }
    throw new Error(`container-docker: tool-exec server '${runtime.name}' never answered: ${String(lastError)}`)
  }

  private resetIdle(key: string): void {
    if (this.idleTimeoutMs === undefined) return
    const previous = this.idleTimers.get(key)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => { this.reap(key) }, this.idleTimeoutMs)
    this.idleTimers.set(key, timer)
  }

  private reap(key: string): void {
    const timer = this.idleTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.idleTimers.delete(key)
    }
    const runtime = this.tenants.get(key)
    if (runtime === undefined) return
    this.tenants.delete(key)
    void this.runner.run(['rm', '-f', runtime.name])
  }
}

export default DockerContainerRuntime
