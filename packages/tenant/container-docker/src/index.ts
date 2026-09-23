/**
 * Local Docker/Podman provider for the container-runtime capability seam
 * (`ctx.containerRuntime`). Starts one small tool-exec server container per
 * (tenant, user) — the case workspace bind-mounted at `/workspace`, the
 * case-shared directory at `/shared`, the subject's cross-case global directory
 * at `/global`, and tooling at `/tools` (read-only) — publishes its HTTP port
 * on a configurable host address, and runs commands by POSTing to that server (ip+host).
 * The container is started lazily on the subject's first tool call and never
 * pays a pre-warmed cold-start it could not honor (a per-user container has no
 * user to warm at boot); its stable name means a non-graceful host shutdown
 * cannot orphan an older execution world (the next start clears the same-name
 * container first). Idle containers are reaped after `idleTimeoutMs`, and the
 * execution world itself is stateless: everything a tenant and user own lives
 * on its mounts, never in the container. Every container CLI invocation, the
 * cold start as a whole, and each tool-exec round trip carry their own deadline,
 * so a wedged daemon or a tool-exec server that stopped answering fails the call
 * instead of leaving it pending — a pending start would otherwise stop every
 * later tool call for that subject until the host process restarts.
 * @module @deepseek-ai/dsh-container-docker
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type { ContainerCommandResult, ContainerExecOptions } from '@deepseek-ai/dsh-container'
import { requireTenant, requireUser, tenantPartitionName, userPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant, UserId } from '@deepseek-ai/dsh-tenant'
import { cliRunner } from './runner.ts'
import type { DockerRunner } from './runner.ts'
import { hostPathProbe, resolvePythonEnvironment } from './python-env.ts'
import type { HostPathProbe, PythonEnvironment } from './python-env.ts'
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
   * @param signal - the caller's fused deadline and cancellation, forwarded to the
   *   HTTP request; omit only when the caller has no bound of its own.
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
   * Host address the tool-exec port is published on. Defaults to the host
   * loopback, which only a harness on the same host network namespace can
   * reach. The server itself authenticates nothing, so widen this to the
   * container bridge gateway (e.g. `172.17.0.1`) rather than to
   * `0.0.0.0` when the harness runs in a container: that keeps an
   * unauthenticated command surface off the surrounding network.
   */
  publishHost?: string
  /**
   * Host address the harness dials to reach that published port. Defaults to
   * the host loopback. A harness running in its own container reaches the host
   * by the gateway name instead (e.g. `host.docker.internal`).
   */
  connectHost?: string
  /**
   * Host root holding one sub-directory per subject (their cross-case global
   * directory), bind-mounted read-write at `/global`. When omitted the `/global`
   * mount is skipped (single-user deployments without a cross-case directory).
   */
  usersRoot?: string
  /**
   * Host directory holding the system-wide skill tree, bind-mounted read-only at
   * the same absolute path. A skill's instructions reference companion files
   * (templates, methodology, verification scripts) relative to the directory the
   * skill was discovered in, so the sandbox must see that directory at the path
   * the host resolved it to; mounting it elsewhere would break every reference.
   * When omitted the system skill tree stays host-only and only skill bodies
   * reach the model.
   */
  systemRoot?: string
  /**
   * Host directory holding the Python runtime every sandbox runs against,
   * bind-mounted read-only at the same absolute path. The tool-exec image ships
   * no interpreter of its own, so this directory is the sandbox's only Python:
   * one portable build (interpreter, standard library, and packages in that one
   * directory, e.g. a python-build-standalone `install_only` tree) serves every
   * sandbox, and a version bump or a new dependency is one directory change
   * rather than an image rebuild. It must run on the image's own glibc (Debian
   * 12), because a build made for a newer one fails to load; a virtual
   * environment is not usable here, since it depends on the standard library
   * and `libpython` of the system it was created on.
   * `<pythonRoot>/bin` goes to the front of `PATH`, `<pythonRoot>/pyvenv.cfg`
   * makes the directory `VIRTUAL_ENV`, and
   * `<pythonRoot>/lib/python3.<minor>/site-packages` joins `PYTHONPATH`.
   * When omitted nothing is mounted and no Python variable is set, so a sandbox
   * has no `python3` at all. A configured path fails the load when this process
   * cannot read it, and also when it holds none of those three markers: either
   * way the mount would configure nothing, and Docker creating a missing
   * bind-mount source as an empty directory makes the second case the likeliest
   * way to reach it.
   */
  pythonRoot?: string
  /**
   * `PATH` the tool-exec image gives its commands, used when `pythonRoot` puts
   * a mounted interpreter's `bin` directory first: `docker run -e PATH=`
   * replaces the image's value instead of extending it, so the rest of PATH has
   * to be restated. Defaults to the shipped image's Debian base PATH
   * (`node:22-bookworm-slim`; `docker/Dockerfile` sets none of its own).
   * Change it together with `toolExecImage` whenever that image's PATH differs,
   * or the directories it adds disappear from every sandbox command.
   */
  toolExecImagePath?: string
  /** Milliseconds of exec idleness before the container is reaped. Omit to keep. */
  idleTimeoutMs?: number
  /**
   * Milliseconds allowed for one `docker`/`podman` invocation — the same-name
   * clear, `run`, `port`, and removal all pass through it. The CLI blocks for as
   * long as the daemon does and the runner kills its child only when it is handed
   * a signal, so this is what bounds a wedged daemon. Defaults to 60000.
   */
  cliTimeoutMs?: number
  /**
   * Milliseconds allowed for one cold start: its CLI calls and the tool-exec
   * readiness wait together. Exceeding it fails the start and clears everything
   * cached for the subject, so the next exec begins a fresh start instead of
   * joining a promise that never settles. Defaults to 180000.
   */
  startTimeoutMs?: number
  /**
   * Milliseconds allowed for one tool-exec HTTP round trip. This covers the
   * command's own execution inside the container, not only the connection, so it
   * is the largest of these deadlines. Defaults to 600000.
   */
  transportTimeoutMs?: number
  /** Milliseconds to wait for a cold container's tool-exec server to answer. Defaults to 10000. */
  readyTimeoutMs?: number
  /** Milliseconds between tool-exec readiness polls. Defaults to 30. */
  readyPollMs?: number
  /**
   * Memory ceiling in Docker's size syntax (e.g. `2g`), applied with
   * `--memory-swap` at the same value so an over-limit subject is OOM-killed
   * inside its own container instead of pushing the host into swap. Omit for no
   * ceiling.
   */
  memoryLimit?: string
  /** CPU ceiling in whole cores. Omit for no ceiling. */
  cpuLimit?: number
}

const PUBLISHED_PORT = /(?:\d+\.\d+\.\d+\.\d+|\[?::\]?):(\d+)/
/**
 * Deadline codes this provider stamps on its own expiries. `timeoutOf` reads
 * them back off the fused signal, which is the only way to tell this provider's
 * expiry apart from the caller's cancellation: both abort the same signal.
 */
const CLI_TIMEOUT = 'CONTAINER_CLI_TIMEOUT'
const START_TIMEOUT = 'CONTAINER_START_TIMEOUT'
const READY_TIMEOUT = 'CONTAINER_READY_TIMEOUT'
const TRANSPORT_TIMEOUT = 'CONTAINER_TRANSPORT_TIMEOUT'
/** Default for {@link Config.cliTimeoutMs}. */
const DEFAULT_CLI_TIMEOUT_MS = 60_000
/** Default for {@link Config.startTimeoutMs}. */
const DEFAULT_START_TIMEOUT_MS = 180_000
/** Default for {@link Config.transportTimeoutMs}. */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 600_000
/** Default for {@link Config.readyTimeoutMs}. */
const DEFAULT_READY_TIMEOUT_MS = 10_000
/** Default for {@link Config.readyPollMs}. */
const DEFAULT_READY_POLL_MS = 30
/** Default for {@link Config.toolExecImagePath}. */
const DEFAULT_TOOL_EXEC_IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

function parsePublishedPort(stdout: string): number | undefined {
  const match = PUBLISHED_PORT.exec(stdout)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * Await one operation, ending the wait as soon as `signal` aborts.
 *
 * The operation keeps running: a promise cannot be interrupted, and a start
 * cached for a (tenant, user) is shared with callers that did not cancel, so the
 * signal detaches this caller instead of cancelling their work. The same signal
 * reaches the operation's own cancellation path, so the abandoned work settles
 * promptly rather than leaving a CLI child behind.
 *
 * @param work - the operation to await.
 * @param signal - the deadline or cancellation that ends the wait.
 * @returns the operation's value, or a rejection carrying `signal`'s reason.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'container-docker: the call was aborted')))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Local Docker/Podman container runtime registered as `ctx.containerRuntime`. */
export class DockerContainerRuntime extends ContainerRuntime {
  static Config: z<Config> = z.object({
    runtime: z.union(['docker', 'podman'] as const).default('docker'),
    network: z.string().default('bridge'),
    toolExecImage: z.string().default('dsh-tool-exec:latest'),
    toolExecPort: z.natural().min(1).default(8642),
    publishHost: z.string().default('127.0.0.1'),
    connectHost: z.string().default('127.0.0.1'),
    usersRoot: z.string(),
    systemRoot: z.string(),
    pythonRoot: z.string(),
    toolExecImagePath: z.string().default(DEFAULT_TOOL_EXEC_IMAGE_PATH),
    idleTimeoutMs: z.natural().min(1),
    cliTimeoutMs: z.natural().min(1).default(DEFAULT_CLI_TIMEOUT_MS),
    startTimeoutMs: z.natural().min(1).default(DEFAULT_START_TIMEOUT_MS),
    transportTimeoutMs: z.natural().min(1).default(DEFAULT_TRANSPORT_TIMEOUT_MS),
    readyTimeoutMs: z.natural().min(1).default(DEFAULT_READY_TIMEOUT_MS),
    readyPollMs: z.natural().min(1).default(DEFAULT_READY_POLL_MS),
    memoryLimit: z.string(),
    cpuLimit: z.natural().min(1),
  })

  private readonly runner: DockerRunner
  private readonly client: ToolExecClient
  private readonly runtimeName: string
  private readonly network: string
  private readonly toolExecImage: string
  private readonly toolExecPort: number
  private readonly publishHost: string
  private readonly connectHost: string
  private readonly usersRoot: string | undefined
  private readonly systemRoot: string | undefined
  private readonly pythonEnv: PythonEnvironment | undefined
  private readonly toolExecImagePath: string
  private readonly idleTimeoutMs: number | undefined
  private readonly cliTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly transportTimeoutMs: number
  private readonly readyTimeoutMs: number
  private readonly readyPollMs: number
  private readonly memoryLimit: string | undefined
  private readonly cpuLimit: number | undefined
  private readonly tenants = new Map<string, TenantRuntime>()
  private readonly starting = new Map<string, Promise<TenantRuntime>>()
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * @param ctx - the Cordis context this provider registers its effects on.
   * @param config - the validated plugin configuration.
   * @param runner - container CLI seam; production spawns the configured binary.
   * @param client - tool-exec HTTP seam; production posts to the published port.
   * @param probe - host filesystem reads for the mounted Python environment; production reads the host.
   */
  constructor(
    ctx: Context,
    config: Config,
    runner?: DockerRunner,
    client?: ToolExecClient,
    probe: HostPathProbe = hostPathProbe,
  ) {
    super(ctx)
    this.runtimeName = config.runtime ?? 'docker'
    this.runner = runner ?? cliRunner(this.runtimeName)
    this.client = client ?? { exec: execToolCommand }
    this.network = config.network ?? 'bridge'
    this.toolExecImage = config.toolExecImage ?? 'dsh-tool-exec:latest'
    this.toolExecPort = config.toolExecPort ?? 8642
    this.publishHost = config.publishHost ?? '127.0.0.1'
    this.connectHost = config.connectHost ?? '127.0.0.1'
    this.usersRoot = config.usersRoot
    this.systemRoot = config.systemRoot
    // Probed once, on the host: the environment's layout fixes the container's
    // start arguments for its lifetime. Packages installed into that directory
    // reach the next sandbox, but creating its bin/pyvenv.cfg/lib after boot
    // needs a restart.
    this.pythonEnv = config.pythonRoot === undefined
      ? undefined
      : resolvePythonEnvironment(config.pythonRoot, probe)
    this.toolExecImagePath = config.toolExecImagePath ?? DEFAULT_TOOL_EXEC_IMAGE_PATH
    this.idleTimeoutMs = config.idleTimeoutMs
    this.cliTimeoutMs = config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
    this.startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.transportTimeoutMs = config.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS
    this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.readyPollMs = config.readyPollMs ?? DEFAULT_READY_POLL_MS
    this.memoryLimit = config.memoryLimit
    this.cpuLimit = config.cpuLimit
    ctx.effect(() => async () => {
      for (const timer of this.idleTimers.values()) clearTimeout(timer)
      this.idleTimers.clear()
      const names = new Set([...this.tenants.values()].map(runtime => runtime.name))
      const settled = await Promise.allSettled([...this.starting.values()])
      for (const result of settled) {
        if (result.status === 'fulfilled') names.add(result.value.name)
      }
      await Promise.allSettled([...names].map(name => this.runCli(['rm', '-f', name])))
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
    // The start blocks in the container CLI, so the caller's cancellation is
    // honored here as well: a cancelled call must not wait out a start it no
    // longer wants.
    const runtime = await this.awaitStart(key, tenant, user, opts?.signal)
    this.resetIdle(key)
    const req: ToolExecRequest = { argv: [command, ...args] }
    if (opts?.cwd !== undefined) req.cwd = opts.cwd
    if (opts?.env !== undefined) req.env = { ...opts.env }
    if (opts?.stdin !== undefined) req.stdin = opts.stdin
    // Caller cancellation and this round trip's own deadline are fused: the
    // tool-exec server can stop answering, and a request with no deadline never
    // settles.
    using transport = deadline(opts?.signal, this.transportTimeoutMs, TRANSPORT_TIMEOUT)
    try {
      return await this.client.exec(this.toolExecBaseUrl(runtime.port), req, transport.signal)
    } catch (error: unknown) {
      // A sandbox has no guaranteed lifetime: the host may restart, an operator may
      // remove the container, the subject may be OOM-killed. The cached address is
      // then dead and every later call fails the same way until the host restarts.
      // `client.exec` rejects only on a transport or protocol failure — a command's
      // own exit status travels in the result — so a rejection means the sandbox may
      // be gone. Discard it and run the same request once against a fresh sandbox
      // instead of surfacing an unreachable-container error to the subject.
      if (opts?.signal?.aborted === true) throw error
      this.discard(key)
      if (timeoutOf(transport.signal, TRANSPORT_TIMEOUT) !== undefined) {
        // An expired deadline is not a transport failure: the command may still
        // be running inside the container, so repeating it here would repeat its
        // side effects. The discard above still leaves the next call on a fresh
        // sandbox.
        throw new Error(
          `container-docker: the tool-exec server of '${runtime.name}' did not answer within ${this.transportTimeoutMs}ms`,
        )
      }
      const fresh = await this.ensure(key, tenant, user)
      this.resetIdle(key)
      return await this.client.exec(this.toolExecBaseUrl(fresh.port), req, transport.signal)
    }
  }

  /**
   * Await the subject's sandbox, honoring the caller's cancellation.
   *
   * `ensure`'s promise is shared with every other caller for the same subject, so
   * cancellation detaches this caller instead of cancelling a start they are
   * waiting on.
   *
   * @param key - the (tenant, user) scope key.
   * @param tenant - the ambient tenant.
   * @param user - the ambient user.
   * @param signal - the caller's cancellation, if any.
   * @returns the subject's live sandbox.
   * @throws the caller's abort reason when `signal` is already aborted or aborts first.
   */
  private async awaitStart(
    key: string,
    tenant: Tenant,
    user: UserId,
    signal: AbortSignal | undefined,
  ): Promise<TenantRuntime> {
    // An already-cancelled call must not start a container nobody will use.
    signal?.throwIfAborted()
    const start = this.ensure(key, tenant, user)
    if (signal === undefined) return await start
    return await raceAbort(start, signal)
  }

  /** The tool-exec server's address as the harness reaches it. */
  private toolExecBaseUrl(port: number): string {
    return `http://${this.connectHost}:${String(port)}`
  }

  private networkFor(tenant: Tenant): string {
    return tenant.network === 'none' ? 'none' : this.network
  }

  /** The in-memory key separating one subject's container within a tenant. */
  private scopeKey(tenantId: Tenant['id'], user: UserId): string {
    return `${tenantId}\u0000${user}`
  }

  /**
   * Resolve the subject's sandbox, starting one on first use.
   *
   * The returned promise always settles: `startTimeoutMs` bounds the start and
   * both settlement paths clear the `starting` entry. A pending entry left behind
   * would hand every later exec on this (tenant, user) the same unsettled
   * promise.
   *
   * @param key - the (tenant, user) scope key.
   * @param tenant - the ambient tenant.
   * @param user - the ambient user.
   * @returns the subject's live sandbox.
   */
  private ensure(key: string, tenant: Tenant, user: UserId): Promise<TenantRuntime> {
    const existing = this.tenants.get(key)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = this.starting.get(key)
    if (pending !== undefined) return pending
    const start = this.startWithinDeadline(key, tenant, user)
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

  /**
   * Start one sandbox under `startTimeoutMs`, leaving nothing cached on failure.
   *
   * @param key - the (tenant, user) scope key.
   * @param tenant - the ambient tenant.
   * @param user - the ambient user.
   * @returns the started sandbox.
   * @throws when the start outlives `startTimeoutMs`, or with the start's own failure.
   */
  private async startWithinDeadline(key: string, tenant: Tenant, user: UserId): Promise<TenantRuntime> {
    using d = deadline(undefined, this.startTimeoutMs, START_TIMEOUT)
    try {
      return await raceAbort(this.startContainer(tenant, user, d.signal), d.signal)
    } catch (error: unknown) {
      // A start that never finished must leave nothing cached for this subject:
      // the `starting` entry would hand every later exec the same unsettled
      // promise, and `discard` drops the cached sandbox and its idle timer.
      this.starting.delete(key)
      this.discard(key)
      const timeout = timeoutOf(d.signal, START_TIMEOUT)
      if (timeout === undefined) throw error
      // The abandoned `startContainer` keeps running: the aborted signal makes
      // each of its remaining CLI calls fail immediately, so it settles with no
      // caller instead of leaving a live start behind.
      throw new Error(
        `container-docker: starting '${this.containerName(tenant, user)}' did not finish within ${timeout.timeoutMs}ms`,
      )
    }
  }

  /**
   * Start one subject's tool-exec container.
   * @param tenant - the ambient tenant.
   * @param user - the ambient user.
   * @param signal - the enclosing start deadline, carried into every CLI call.
   * @returns the running container's name and published host port.
   */
  private async startContainer(tenant: Tenant, user: UserId, signal: AbortSignal): Promise<TenantRuntime> {
    // One stable, (tenant, user)-partitioned name, so at most one execution
    // world exists per subject in a tenant at a time: clear any same-name
    // container a non-graceful host shutdown left behind before starting
    // (docker rm -f is a no-op when absent).
    const name = this.containerName(tenant, user)
    await this.runCli(['rm', '-f', name], signal)
    const args = [
      'run', '-d', '--name', name, '--network', this.networkFor(tenant),
      // The host gateway is reachable from the container at this name, so a
      // mounted runtime (code-runtime-container) can bridge its declared
      // host-side bindings back over the loopback HTTP surface it publishes.
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `${this.publishHost}::${String(this.toolExecPort)}`,
    ]
    if (this.memoryLimit !== undefined) {
      // Without the matching --memory-swap Docker defaults it to twice the memory
      // limit, letting an over-limit subject swap the host instead of dying in place.
      args.push('--memory', this.memoryLimit, '--memory-swap', this.memoryLimit)
    }
    if (this.cpuLimit !== undefined) {
      args.push('--cpus', String(this.cpuLimit))
    }
    args.push(
      '-v', `${tenant.workspaceRoot}/users/${user}:/workspace`,
      '-v', `${tenant.workspaceRoot}/shared:/shared`,
      // The case-shared skill tier reports its own host directory as a skill's base
      // directory, and a skill body tells the model to resolve relative paths against
      // it. That path must therefore resolve inside the sandbox too. The same tree is
      // already writable at /shared, so this read-only view adds reachability without
      // adding authority.
      '-v', `${tenant.workspaceRoot}/shared/skills:${tenant.workspaceRoot}/shared/skills:ro`,
    )
    if (this.usersRoot !== undefined) {
      args.push('-v', `${this.usersRoot}/${user}:/global`)
    }
    if (this.systemRoot !== undefined) {
      // Read-only at its own absolute path: skill bodies reach the model through the
      // host-side skill provider, but the companion files they cite are readable only
      // through the sandbox.
      args.push('-v', `${this.systemRoot}:${this.systemRoot}:ro`)
    }
    if (tenant.toolsRoot !== undefined) {
      args.push('-v', `${tenant.toolsRoot}:/tools:ro`)
    }
    args.push(...this.pythonArgs())
    // The platform knows which case and subject a sandbox belongs to, so it
    // states it: a skill that must locate its own case otherwise infers identity
    // from the container name or the `/shared` directory name, and Docker sets
    // `/etc/hostname` to the container id, so that inference lands nowhere.
    args.push(
      '-e', `DSH_CASE_ID=${tenant.id}`,
      '-e', `DSH_TENANT_ID=${tenant.id}`,
      '-e', `DSH_USER_ID=${user}`,
    )
    args.push(this.toolExecImage)
    const result = await this.runCli(args, signal)
    if (result.exitCode !== 0) {
      throw new Error(`container-docker: '${name}' failed to start (exit ${result.exitCode}): ${result.stderr}`)
    }
    const port = await this.readPublishedPort(name, signal)
    const runtime = { name, port }
    await this.waitReady(runtime, signal)
    return runtime
  }

  /** The stable, (tenant, user)-partitioned name of one subject's container. */
  private containerName(tenant: Tenant, user: UserId): string {
    return `dsh-${tenantPartitionName(tenant.id)}-${userPartitionName(user)}`
  }

  /**
   * The mount and environment variables that put the host's Python environment
   * in front of the sandbox's own interpreter.
   *
   * Read-only at its own absolute path, because the environment's scripts,
   * `pyvenv.cfg`, and `.pth` files name that path and the sandbox only reads
   * it. Each variable follows its own probe: a directory holding only `bin`
   * gets `PATH` alone.
   *
   * @returns the `docker run` arguments for the mounted environment, empty when none is configured.
   */
  private pythonArgs(): string[] {
    const environment = this.pythonEnv
    if (environment === undefined) return []
    const args = ['-v', `${environment.root}:${environment.root}:ro`]
    if (environment.bin !== undefined) args.push('-e', `PATH=${environment.bin}:${this.toolExecImagePath}`)
    if (environment.virtualEnv !== undefined) args.push('-e', `VIRTUAL_ENV=${environment.virtualEnv}`)
    if (environment.sitePackages !== undefined) args.push('-e', `PYTHONPATH=${environment.sitePackages}`)
    return args
  }

  private async readPublishedPort(name: string, signal: AbortSignal): Promise<number> {
    const result = await this.runCli(['port', name, String(this.toolExecPort)], signal)
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
   * @param signal - the enclosing start deadline, fused with the readiness budget.
   * @throws when the server stays unreachable past `readyTimeoutMs`.
   */
  private async waitReady(runtime: TenantRuntime, signal: AbortSignal): Promise<void> {
    const baseUrl = this.toolExecBaseUrl(runtime.port)
    using d = deadline(signal, this.readyTimeoutMs, READY_TIMEOUT)
    let lastError: unknown
    while (!d.signal.aborted) {
      try {
        await this.client.exec(baseUrl, { argv: ['sh', '-c', 'true'] }, d.signal)
        return
      } catch (error: unknown) {
        lastError = error
        await new Promise<void>(resolve => setTimeout(resolve, this.readyPollMs))
      }
    }
    // An enclosing deadline that expired first is the start's own failure, not a
    // readiness one; naming it here would report two causes for one expiry.
    if (timeoutOf(d.signal, READY_TIMEOUT) === undefined) {
      throw new Error(`container-docker: starting '${runtime.name}' stopped before its tool-exec server answered`)
    }
    throw new Error(`container-docker: tool-exec server '${runtime.name}' never answered: ${String(lastError)}`)
  }

  private resetIdle(key: string): void {
    if (this.idleTimeoutMs === undefined) return
    const previous = this.idleTimers.get(key)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => { this.discard(key) }, this.idleTimeoutMs)
    this.idleTimers.set(key, timer)
  }

  /**
   * Drop the cached sandbox for a subject and remove its container. Idleness and a
   * failed exec both reach here: the next `ensure` starts a replacement.
   *
   * @param key - the (tenant, user) scope key whose sandbox is being discarded.
   */
  private discard(key: string): void {
    const timer = this.idleTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.idleTimers.delete(key)
    }
    const runtime = this.tenants.get(key)
    if (runtime === undefined) return
    this.tenants.delete(key)
    this.removeContainer(runtime.name)
  }

  /**
   * Remove one container by name, bounded by `cliTimeoutMs`. The caller is not
   * waiting on this: the next start clears the same name before it runs.
   * @param name - the container's stable name.
   */
  private removeContainer(name: string): void {
    void this.runCli(['rm', '-f', name]).catch(() => {
      // The container is already gone or unreachable; the next start's clear
      // covers both, and nothing else can act on this failure.
    })
  }

  /**
   * Run one container CLI command under `cliTimeoutMs`.
   *
   * Every CLI call goes through here: `docker`/`podman` block for as long as the
   * daemon does, and the runner kills its child only when it is handed a signal,
   * so an unbounded call is an unbounded await.
   *
   * @param args - the docker/podman subcommand and arguments.
   * @param signal - the enclosing start deadline, fused with this call's own.
   * @returns the command's exit code and captured streams.
   * @throws when the call outlives `cliTimeoutMs`, or when the enclosing deadline already expired.
   */
  private async runCli(args: readonly string[], signal?: AbortSignal): Promise<ContainerCommandResult> {
    if (signal?.aborted === true) {
      throw new Error(`container-docker: '${this.runtimeName} ${args.join(' ')}' was not run: its deadline already expired`)
    }
    using d = deadline(signal, this.cliTimeoutMs, CLI_TIMEOUT)
    let result: ContainerCommandResult
    try {
      result = await this.runner.run(args, { signal: d.signal })
    } catch (error: unknown) {
      if (timeoutOf(d.signal, CLI_TIMEOUT) === undefined) throw error
      throw this.cliTimeoutError(args)
    }
    // The runner reports a killed child as exit code 0 — a signalled process has
    // no exit code of its own — so a fired deadline is the only evidence that
    // this call did not finish.
    if (timeoutOf(d.signal, CLI_TIMEOUT) !== undefined) throw this.cliTimeoutError(args)
    return result
  }

  /** The error for one CLI call that outlived its deadline. */
  private cliTimeoutError(args: readonly string[]): Error {
    return new Error(
      `container-docker: '${this.runtimeName} ${args.join(' ')}' did not finish within ${this.cliTimeoutMs}ms`,
    )
  }
}

export default DockerContainerRuntime
