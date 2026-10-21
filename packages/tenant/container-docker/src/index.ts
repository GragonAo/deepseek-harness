/**
 * Local Docker/Podman provider for the container-runtime capability seam
 * (`ctx.containerRuntime`). Starts one small tool-exec server container per
 * (tenant, user) — the case workspace bind-mounted at `/workspace`, the
 * case work directory at `/case`, the subject's per-session work directories
 * at `/sessions`, the subject's cross-case global directory
 * at `/global`, and tooling at `/tools` (read-only) — publishes its HTTP port
 * on a configurable host address, and runs commands by POSTing to that server (ip+host).
 * The container is started lazily on the subject's first tool call and never
 * pays a pre-warmed cold-start it could not honor (a per-user container has no
 * user to warm at boot); its stable name means a non-graceful host shutdown
 * cannot orphan an older execution world (the next start clears the same-name
 * container first). Every bind-mount source is checked on the host first, because
 * the container runtime creates a missing one as an empty directory instead of
 * failing. Idle containers exit by themselves after `idleTimeoutMs`: the
 * provider injects the budget and the container judges its own idleness, because
 * every request reaches the container while the host cache cannot see another
 * replica's use of the same sandbox. The provider likewise injects
 * `maxOutputBytes`, because the container holds a command's whole stream before
 * the host's subprocess capability can bound the result: the container keeps
 * draining past that bound, retains the tail of each stream, and marks the
 * stream as truncated. The execution world itself is stateless: everything a
 * tenant and user own lives on its mounts, never in the container. Every
 * container CLI invocation, the cold start as a whole, and each tool-exec round
 * trip carry their own deadline, so a wedged daemon or a tool-exec server that
 * stopped answering fails the call instead of leaving it pending — a pending
 * start would otherwise stop every later tool call for that subject until the
 * host process restarts.
 *
 * 本包与 `container-k8s` 是 `ctx.containerRuntime` 上的两个实现，因此沙箱内的事实逐条对齐：
 * 同一张挂载表（`/workspace`、`/case`、`<workspaceRoot>/skills`、`/sessions`、`/global`、
 * `systemRoot` 同路径、`/tools`、`pythonRoot` 同路径）、同一套 Python 三件套
 * （`PATH` 前置、`VIRTUAL_ENV`、`PYTHONPATH`）、同一组身份变量
 * （`DSH_CASE_ID`/`DSH_TENANT_ID`/`DSH_USER_ID`）、同一条 `/tools` 来源规则
 * （租户记录优先，缺省回落配置），以及同名同义的 `idleTimeoutMs`（空闲回收）、
 * `maxOutputBytes`（容器内的原始流上界）、`sandboxCacheTtlMs`（句柄缓存 TTL）、
 * `cliTimeoutMs`、`startTimeoutMs`、`transportTimeoutMs`。
 * 两边只在「事实从哪里来」上不同：容器在宿主上，Pod 在集群里。
 * @module @deepseek-ai/dsh-container-docker
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type {
  ContainerCommandResult,
  ContainerExecOptions,
  ContainerPtyOptions,
  ContainerPtySession,
} from '@deepseek-ai/dsh-container'
import { SANDBOX_CASE_MOUNT, SANDBOX_SESSIONS_MOUNT, SANDBOX_WORKDIR_ENV, SANDBOX_WORKSPACE_MOUNT, TENANT_SESSIONS_DIR_NAME, TENANT_SKILL_DIR_NAME, TENANT_USERS_DIR_NAME, TENANT_WORK_DIR_NAME, requireTenant, requireUser, sandboxSessionDir, tenantPartitionName, userPartitionName } from '@deepseek-ai/dsh-tenant'
import type { Tenant, UserId } from '@deepseek-ai/dsh-tenant'
import { openContainerPty, ptyRunner } from '@deepseek-ai/dsh-container-transport'
import type { ContainerPtyRunner, ContainerSessionExec } from '@deepseek-ai/dsh-container-transport'
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
  /**
   * 这个句柄可以直接用到什么时候，单位毫秒（`Date.now()` 刻度）。到期后
   * {@link DockerContainerRuntime.ensure} 先用一次 `docker port` 向运行时确认它。
   */
  expiresAt: number
}

/** Plugin configuration. */
export interface Config {
  /** Container CLI binary: `docker` or `podman`. */
  runtime?: 'docker' | 'podman'
  /** Docker network name used unless the tenant opts into `none`. */
  network?: string
  /** In-container tool-exec image run as each (tenant, user)'s execution world. */
  toolExecImage?: string
  /**
   * Container port the tool-exec server binds (published to a random host port).
   *
   * 本 provider 把它同时用在两处：`-p` 发布的容器端口，以及镜像 entrypoint 的第一个位置参数
   * （契约是 `entry.mjs <port> [host]`，见 `docker/entry.mjs`）。命令参数由本 provider 显式传下去，
   * 不再依赖镜像 `CMD` 里那个 8642，因此改这个值真的会改沙箱内的监听端口。
   */
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
   * `/case`（案件工作目录）是否对沙箱只读，默认只读。
   *
   * 它由一个案件下的所有用户共用，业务侧通过管理接口写入；沙箱可写就意味着任何用户的沙箱都能
   * 改到别人的输入。案件级的 `config`、`skills`、`tools` 三棵树与它平级、各自只读挂载，
   * 松开它只松开工作目录本身。
   */
  caseReadOnly?: boolean
  /**
   * `/global`（该 subject 的跨案件目录）是否对沙箱只读，默认只读。
   *
   * 它盛放用户全局提交上来的文件，由业务侧写入；用户全局技能树是它的同级目录、单独只读
   * 挂载，松开它只松开工作目录本身。
   */
  usersReadOnly?: boolean
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
   * `/tools` 挂载的来源，供租户记录里没有 `toolsRoot` 的租户使用。来源规则是租户记录优先：
   * `tenant.toolsRoot` 存在时用它，缺省才回落到这里。省略本字段则这类租户的沙箱没有
   * `/tools` 挂载。（`container-k8s` 的同名字段逐字同义。）
   */
  toolsRoot?: string
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
  /**
   * 空闲多久后让该主体的沙箱容器自己退出，单位毫秒：provider 把它作为 `DSH_TOOL_EXEC_IDLE_MS`
   * 注入容器，容器据此判定「没有在途请求、且距上一次请求已超过预算」后自行退出，留下一个终态
   * 容器由下一次启动的收尸清掉（见 `tool-exec.ts`）。宿主不自己计时：它看不见别的副本对这个
   * 沙箱的使用，而每一个请求都要到达容器。正在执行的命令不算空闲。省略则容器永不自行退出
   * （长期不用的主体会一直占着一份容器资源）。粒度是这个主体，不是全局。
   */
  idleTimeoutMs?: number
  /**
   * 沙箱内每次 exec 里**每条输出流**最多保留多少字节：provider 把它作为
   * `DSH_TOOL_EXEC_MAX_OUTPUT_BYTES` 注入容器，容器超过上界后继续读完这条流（停止读会让子进程
   * 在写满管道时阻塞），只保留末尾一段，并在结果里把该流标成已截断（见 `tool-exec.ts`）。
   * 上界只需高于宿主自己的结果上界（`ctx.subprocess` 的每条流预算），它的用处是保护沙箱自己：
   * 原始流是容器先攒满、宿主才轮得到加界的，所以一条大输出命令能撑死沙箱。调低它会连带截断那些
   * 本来整段读得回来的大结果（整份文件读取、`run_code` 自己 64 MiB 的载荷上界），所以它要留在
   * 部署里那些上界之上。与 `container-k8s` 的同名字段逐字同义。默认 67108864。
   */
  maxOutputBytes?: number
  /**
   * 一个已解析的沙箱句柄在多少毫秒内可以直接复用，过后先用一次 `docker port` 向运行时确认它，
   * 并顺手刷新发布端口（容器被 OOM 杀掉、被运维删掉、daemon 重启时句柄都会失效）。
   * 沙箱自行退出后句柄也留在缓存里，所以这个上限是唯一约束「过期端口还能用多久」的地方：
   * 过期后第一次 exec 会失败一次，由 exec 的重试路径重建。
   * 与 `container-k8s` 的同名字段逐字同义。默认 5000。
   */
  sandboxCacheTtlMs?: number
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

/** One bind mount a sandbox is started with. */
interface MountSource {
  /** Host absolute path the container runtime resolves. */
  source: string
  /** Path inside the container the source is mounted at. */
  target: string
  /** Whether the mount is read-only. */
  readOnly: boolean
}

/** The `docker run -v` argument one mount contributes. */
function mountArgument(mount: MountSource): string {
  return `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`
}

/**
 * The diagnostic for a start whose bind-mount sources this host does not have.
 *
 * Docker creates a missing bind-mount source as an empty directory, so a start
 * that skipped this check reports success and hands the subject an empty mount.
 * The tenant and the member are part of the message because they are what an
 * operator needs to find the directory: the per-tenant sources are that pair's.
 *
 * @param missing - the mounts whose host source is absent.
 * @param tenant - the tenant whose sandbox was about to start.
 * @param user - the subject whose sandbox was about to start.
 * @returns the message naming every missing source, the container path it was for, and both sides of the (tenant, member) pair.
 */
function missingMountMessage(missing: readonly MountSource[], tenant: Tenant, user: UserId): string {
  const listed = missing.map(mount => `'${mount.source}' (for '${mount.target}')`).join(', ')
  const noun = missing.length === 1 ? 'bind-mount source' : 'bind-mount sources'
  const verb = missing.length === 1 ? 'is' : 'are'
  return `container-docker: refusing to start the sandbox of tenant '${String(tenant.id)}' member '${user}': ${noun} ${listed} ${verb} missing on this host. `
    + 'Docker creates a missing bind-mount source as an empty directory, so the start would report success and hand that subject an empty mount. '
    + "Create each path on the host, or drop the configuration that names it: tenant-admin creates '<workspaceRoot>/<tier>' and '<workspaceRoot>/users/<subject>' on tenant create and member add, "
    + "and the deployment owns 'usersRoot', 'systemRoot', 'pythonRoot', and the '/tools' root — a tenant's own 'toolsRoot', or the provider-wide fallback of the same name."
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
/** Default for {@link Config.sandboxCacheTtlMs}. */
const DEFAULT_SANDBOX_CACHE_TTL_MS = 5_000
/**
 * {@link Config.caseReadOnly} 与 {@link Config.usersReadOnly} 的默认值：都只读。
 *
 * 这两棵目录树由业务侧写入，沙箱只是读取方；可写就会让一个用户的沙箱改到同案件其他用户的输入，
 * 也会让它们下面那两层只读的技能挂载失去意义。
 */
const DEFAULT_DATA_READ_ONLY = true
/**
 * {@link Config.maxOutputBytes} 的默认值：每条输出流 64 MiB。
 *
 * 它只受一个约束——**高于**宿主自己的结果上界（`ctx.subprocess` 的每条流预算默认 64 KB，
 * 见 `dsh-bash-local` 的 `maxOutputBytes`），容器这一层只负责让沙箱不被一条大输出命令撑死，
 * 所以取值与仓库里已有的两个 64 MiB 量级预算一致：`dsh-bash-local` 的 `maxSpillBytes` 与
 * `dsh-code-runtime-container` 的 `maxOutputBytes`（后者是沙箱内那次 exec 载荷自己的上界，
 * 调大它就必须同步调大这里）。
 */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
/** 沙箱容器的托管标签：与 `container-k8s` 打在 Pod 上的是同一个键值，收尸时认它。 */
const MANAGED_LABEL = 'dsh.dev/managed'
/** 承载沙箱空闲预算的环境变量名：`docker/entry.mjs` 读它，`container-k8s` 注入同名变量。 */
const TOOL_EXEC_IDLE_ENV = 'DSH_TOOL_EXEC_IDLE_MS'
/** 承载沙箱输出上界的变量名：`docker/entry.mjs` 读它，`container-k8s` 注入同名变量。 */
const TOOL_EXEC_MAX_OUTPUT_ENV = 'DSH_TOOL_EXEC_MAX_OUTPUT_BYTES'

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
      // 取消者没有义务给出 Error：非 Error 的 reason 只能字符串化后包一层，
      // 否则调用方拿到的是一个既读不出也说不出用途的东西。
      reject(reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? `container-docker: the call was aborted: ${reason}` : 'container-docker: the call was aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        // 共享操作自己的失败原样转交：在这里换成另一种错误，等于抹掉调用方唯一能读到的东西。
        reject(error instanceof Error ? error : new Error(String(error)))
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
    caseReadOnly: z.boolean().default(DEFAULT_DATA_READ_ONLY),
    usersReadOnly: z.boolean().default(DEFAULT_DATA_READ_ONLY),
    systemRoot: z.string(),
    pythonRoot: z.string(),
    toolsRoot: z.string(),
    toolExecImagePath: z.string().default(DEFAULT_TOOL_EXEC_IMAGE_PATH),
    idleTimeoutMs: z.natural().min(1),
    maxOutputBytes: z.natural().min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
    sandboxCacheTtlMs: z.natural().min(1).default(DEFAULT_SANDBOX_CACHE_TTL_MS),
    cliTimeoutMs: z.natural().min(1).default(DEFAULT_CLI_TIMEOUT_MS),
    startTimeoutMs: z.natural().min(1).default(DEFAULT_START_TIMEOUT_MS),
    transportTimeoutMs: z.natural().min(1).default(DEFAULT_TRANSPORT_TIMEOUT_MS),
    readyTimeoutMs: z.natural().min(1).default(DEFAULT_READY_TIMEOUT_MS),
    readyPollMs: z.natural().min(1).default(DEFAULT_READY_POLL_MS),
    memoryLimit: z.string(),
    cpuLimit: z.natural().min(1),
  })

  private readonly runner: DockerRunner
  private readonly pty: ContainerPtyRunner
  private readonly client: ToolExecClient
  private readonly probe: HostPathProbe
  private readonly runtimeName: string
  private readonly network: string
  private readonly toolExecImage: string
  private readonly toolExecPort: number
  private readonly publishHost: string
  private readonly connectHost: string
  private readonly usersRoot: string | undefined
  private readonly caseReadOnly: boolean
  private readonly usersReadOnly: boolean
  private readonly systemRoot: string | undefined
  private readonly toolsRoot: string | undefined
  private readonly pythonEnv: PythonEnvironment | undefined
  private readonly toolExecImagePath: string
  private readonly idleTimeoutMs: number | undefined
  private readonly maxOutputBytes: number
  private readonly sandboxCacheTtlMs: number
  private readonly cliTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly transportTimeoutMs: number
  private readonly readyTimeoutMs: number
  private readonly readyPollMs: number
  private readonly memoryLimit: string | undefined
  private readonly cpuLimit: number | undefined
  private readonly tenants = new Map<string, TenantRuntime>()
  private readonly starting = new Map<string, Promise<TenantRuntime>>()
  /** Session work directories already created, by (tenant, subject, session): the directory lives on the mount, not in the container. */
  private readonly sessionDirs = new Set<string>()

  /**
   * @param ctx - the Cordis context this provider registers its effects on.
   * @param config - the validated plugin configuration.
   * @param runner - container CLI seam; production spawns the configured binary.
   * @param client - tool-exec HTTP seam; production posts to the published port.
   * @param probe - host filesystem reads, for the mounted Python environment and
   *   for the bind-mount sources of every start; production reads the host.
   * @param pty - interactive-terminal seam; production runs the container CLI on
   *   a terminal the host allocates.
   */
  constructor(
    ctx: Context,
    config: Config,
    runner?: DockerRunner,
    client?: ToolExecClient,
    probe: HostPathProbe = hostPathProbe,
    pty?: ContainerPtyRunner,
  ) {
    super(ctx)
    this.runtimeName = config.runtime ?? 'docker'
    this.runner = runner ?? cliRunner(this.runtimeName)
    this.pty = pty ?? ptyRunner(this.runtimeName)
    this.probe = probe
    this.client = client ?? { exec: execToolCommand }
    this.network = config.network ?? 'bridge'
    this.toolExecImage = config.toolExecImage ?? 'dsh-tool-exec:latest'
    this.toolExecPort = config.toolExecPort ?? 8642
    this.publishHost = config.publishHost ?? '127.0.0.1'
    this.connectHost = config.connectHost ?? '127.0.0.1'
    this.usersRoot = config.usersRoot
    this.caseReadOnly = config.caseReadOnly ?? DEFAULT_DATA_READ_ONLY
    this.usersReadOnly = config.usersReadOnly ?? DEFAULT_DATA_READ_ONLY
    this.systemRoot = config.systemRoot
    this.toolsRoot = config.toolsRoot
    // Probed once, on the host: the environment's layout fixes the container's
    // start arguments for its lifetime. Packages installed into that directory
    // reach the next sandbox, but creating its bin/pyvenv.cfg/lib after boot
    // needs a restart.
    this.pythonEnv = config.pythonRoot === undefined
      ? undefined
      : resolvePythonEnvironment(config.pythonRoot, probe)
    this.toolExecImagePath = config.toolExecImagePath ?? DEFAULT_TOOL_EXEC_IMAGE_PATH
    this.idleTimeoutMs = config.idleTimeoutMs
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.sandboxCacheTtlMs = config.sandboxCacheTtlMs ?? DEFAULT_SANDBOX_CACHE_TTL_MS
    this.cliTimeoutMs = config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
    this.startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.transportTimeoutMs = config.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS
    this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.readyPollMs = config.readyPollMs ?? DEFAULT_READY_POLL_MS
    this.memoryLimit = config.memoryLimit
    this.cpuLimit = config.cpuLimit
    ctx.effect(() => {
      // 启动时收一次尸：容器自己的空闲 watchdog 退出后留下的终态容器，以及宿主非优雅退出
      // 时没来得及清掉的那些，都不再属于任何人。只碰已退出的容器——正在运行的可能是另一个
      // 副本正在用的沙箱，删它就是两个实例互相替换对方的工作。
      void this.reapTerminalContainers().catch(() => {
        // 收尸是尽力而为的清洁：失败与成功没有区别，下一次启动还会再收一次，
        // 而这里没有别的行为依赖它的结果。
      })
      return async () => {
        const names = new Set([...this.tenants.values()].map(runtime => runtime.name))
        const settled = await Promise.allSettled([...this.starting.values()])
        for (const result of settled) {
          if (result.status === 'fulfilled') names.add(result.value.name)
        }
        await Promise.allSettled([...names].map(name => this.runCli(['rm', '-f', name])))
      }
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
    /* jscpd:ignore-start -- 这一段与 container-k8s/src/index.ts 的对应段落是同一套语义：
       两个 provider 都必须让调用方的取消只脱离本次调用，并把取消与这一轮传输期限融在一起。
       抽到共享位置会把 provider 生命周期塞进传输接缝，而那里只该有 CLI 与 HTTP 两个接缝。 */
    // The start blocks in the container CLI, so the caller's cancellation is
    // honored here as well: a cancelled call must not wait out a start it no
    // longer wants.
    const runtime = await this.awaitStart(key, tenant, user, opts?.signal)
    const req: ToolExecRequest = { argv: [command, ...args] }
    if (opts?.cwd !== undefined) req.cwd = opts.cwd
    if (opts?.env !== undefined) req.env = { ...opts.env }
    if (opts?.stdin !== undefined) req.stdin = opts.stdin
    // The session work directory overrides the caller's own working directory: the
    // caller holds a path on its own machine, while the path inside the sandbox is
    // decided by the mount table. An exec with no session (a probe, a host tool call)
    // keeps whatever the caller asked for.
    const sessionDir = sandboxSessionDir(opts?.env)
    if (sessionDir !== undefined) {
      req.cwd = sessionDir
      req.env = { ...(req.env ?? {}), [SANDBOX_WORKDIR_ENV]: sessionDir }
    }
    // Caller cancellation and this round trip's own deadline are fused: the
    // tool-exec server can stop answering, and a request with no deadline never
    // settles.
    using transport = deadline(opts?.signal, this.transportTimeoutMs, TRANSPORT_TIMEOUT)
    /* jscpd:ignore-end */
    try {
      // The session directory lives on the mounted session root, so it may already
      // exist (another sandbox of the same subject, or a previous start) or not exist
      // yet: `mkdir -p` is right either way, and each session runs it once.
      if (sessionDir !== undefined) await this.ensureSessionDir(runtime.port, key, sessionDir, transport.signal)
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
      return await this.client.exec(this.toolExecBaseUrl(fresh.port), req, transport.signal)
    }
  }

  /**
   * Open an interactive terminal inside the ambient tenant's sandbox.
   *
   * `docker exec -i -t` makes the daemon allocate a real PTY in the container,
   * so `isatty` is true and line editing and interactive programs work — what
   * the one-shot `POST /exec` cannot give. The container CLI itself needs a
   * terminal for `-i -t` (it refuses to start when its own stdin is a pipe), so
   * it runs on one the host allocates.
   *
   * The sandbox is pinned here rather than re-resolved per probe: after this
   * session is published its caller may no longer be inside the request that
   * opened it, and resolving (tenant, user) from the ambient scope then would
   * reach another subject's container.
   *
   * @param options - command line inside the sandbox, terminal size, retained
   *   output bound, and cancellation.
   * @returns the live session.
   * @throws `TenantError` code `NO_TENANT_IN_SCOPE` outside an authenticated
   * request, and the provider's own failure when the container cannot be
   * started or the command never took over its terminal.
   */
  async openPty(options: ContainerPtyOptions): Promise<ContainerPtySession> {
    const tenant = requireTenant()
    const user = requireUser()
    const key = this.scopeKey(tenant.id, user)
    const runtime = await this.awaitStart(key, tenant, user, options.signal)
    const port = runtime.port
    const exec: ContainerSessionExec = async (command, args, signal) => {
      // A probe is a round trip like any other, so it carries the same
      // transport deadline: a tool-exec server that stopped answering must fail
      // the probe instead of leaving every later one pending.
      using transport = deadline(signal, this.transportTimeoutMs, TRANSPORT_TIMEOUT)
      return await this.client.exec(this.toolExecBaseUrl(port), { argv: [command, ...args] }, transport.signal)
    }
    return await openContainerPty({
      argv: ['exec', '-i', '-t', runtime.name, options.command, ...options.args ?? []],
      options,
      runner: this.pty,
      exec,
      roundTripTimeoutMs: this.transportTimeoutMs,
    })
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
  /**
   * Create one session's work directory, once per (tenant, subject, session).
   *
   * The directory lives on the mounted case workspace, so it may already exist: sandboxes
   * are replaced, directories are not. `mkdir -p` covers both cases, which is why this
   * never looks first.
   * @param port - The tool-exec port of the sandbox to create the directory in.
   * @param key - The (tenant, subject) scope key.
   * @param sessionDir - Absolute path of the session work directory inside the sandbox.
   * @param signal - This round trip's deadline.
   */
  private async ensureSessionDir(port: number, key: string, sessionDir: string, signal: AbortSignal): Promise<void> {
    const seen = `${key} ${sessionDir}`
    if (this.sessionDirs.has(seen)) return
    await this.client.exec(this.toolExecBaseUrl(port), { argv: ['mkdir', '-p', sessionDir] }, signal)
    this.sessionDirs.add(seen)
  }

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
   * 解析该主体的沙箱：缓存仍有效就直接用，过期就先确认一次，没有才冷启动。
   *
   * 返回的 promise 一定会 settle：`startTimeoutMs` 给启动上界，两条 settle 路径都清掉
   * `starting` 里那一项。留下的 pending 项会把同一个永不 settle 的 promise
   * 交给这个 (租户, 用户) 之后每一次 exec。
   *
   * @param key - (租户, 用户) 作用域键。
   * @param tenant - 当前租户。
   * @param user - 当前用户。
   * @returns 该主体活着的沙箱。
   */
  private ensure(key: string, tenant: Tenant, user: UserId): Promise<TenantRuntime> {
    const cached = this.tenants.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached)
    const pending = this.starting.get(key)
    if (pending !== undefined) return pending
    const start = cached === undefined
      ? this.startWithinDeadline(key, tenant, user)
      : this.reconfirm(key, cached, tenant, user)
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
   * 句柄过了 `sandboxCacheTtlMs` 之后的处理：向运行时确认它一次，确认不了就重新冷启动。
   *
   * 这一步不重建容器——容器可能只是这个主体的句柄旧了，而它还在好好地跑着——所以只花一次
   * `docker port`。容器真的不在了（被杀、被删、daemon 重启）时才走冷启动。
   *
   * @param key - (租户, 用户) 作用域键。
   * @param cached - 已过期、仍待确认的句柄。
   * @param tenant - 当前租户。
   * @param user - 当前用户。
   * @returns 确认后的句柄，或一次冷启动的结果。
   */
  private async reconfirm(
    key: string,
    cached: TenantRuntime,
    tenant: Tenant,
    user: UserId,
  ): Promise<TenantRuntime> {
    const port = await this.reconfirmedPort(cached.name)
    if (port !== undefined) {
      return { name: cached.name, port, expiresAt: Date.now() + this.sandboxCacheTtlMs }
    }
    // The handle is stale: drop it and its container, then start a replacement
    // rather than keep dialing a port nothing publishes.
    this.discard(key)
    return await this.startWithinDeadline(key, tenant, user)
  }

  /**
   * 读回一个已缓存容器当前发布的 host 端口。
   * @param name - 容器的稳定名字。
   * @returns 容器还在时它现在发布的端口；容器已不在、端口读不出来或这次调用自己超时（daemon 卡住）时为 undefined。
   */
  private async reconfirmedPort(name: string): Promise<number | undefined> {
    let result: ContainerCommandResult
    try {
      result = await this.runCli(['port', name, String(this.toolExecPort)])
    } catch {
      // 这条调用只有 `cliTimeoutMs` 一种失败：daemon 卡住。容器是否还在无从判断，
      // 因此按「句柄不可信」处理，让调用方退回一次冷启动。
      return undefined
    }
    return result.exitCode === 0 ? parsePublishedPort(result.stdout) : undefined
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
    // Every source is checked before the container CLI is touched: Docker creates a
    // missing bind-mount source as an empty directory, so a start would otherwise
    // succeed with an empty mount and no diagnostic anywhere.
    const mounts = this.mounts(tenant, user)
    this.requireMountSources(mounts, tenant, user)
    // One stable, (tenant, user)-partitioned name, so at most one execution
    // world exists per subject in a tenant at a time: clear any same-name
    // container a non-graceful host shutdown left behind before starting
    // (docker rm -f is a no-op when absent).
    const name = this.containerName(tenant, user)
    await this.runCli(['rm', '-f', name], signal)
    const args = [
      'run', '-d', '--name', name,
      // 与 container-k8s 给 Pod 打的是同一个标签：它声明「这个容器由本 provider 管理」，
      // 是收尸时唯一能认出自己人的依据——按名字前缀认会误伤别的租户与别的实例。
      '--label', `${MANAGED_LABEL}=true`,
      '--network', this.networkFor(tenant),
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
    for (const mount of mounts) args.push('-v', mountArgument(mount))
    args.push(...this.pythonEnvironmentArgs())
    // The platform knows which case and subject a sandbox belongs to, so it
    // states it: a skill that must locate its own case otherwise infers identity
    // from the container name or the `/case` directory name, and Docker sets
    // `/etc/hostname` to the container id, so that inference lands nowhere.
    // 这三个变量是沙箱内命令的公共事实，`container-k8s` 给每个 Pod 设的是同一组同名变量；
    // 都由平台给出，因此它们排在配置的环境变量之后，配置改不了身份。
    args.push(
      '-e', `DSH_CASE_ID=${tenant.id}`,
      '-e', `DSH_TENANT_ID=${tenant.id}`,
      '-e', `DSH_USER_ID=${user}`,
    )
    // 空闲预算交给沙箱自己执行：宿主看不见别的副本对它的使用，而每一个请求都要到达容器，
    // 所以「有没有人用」只有容器答得准。与身份变量一样由平台给出，排在配置的环境变量之后。
    if (this.idleTimeoutMs !== undefined) {
      args.push('-e', `${TOOL_EXEC_IDLE_ENV}=${String(this.idleTimeoutMs)}`)
    }
    // 输出上界同样由沙箱自己执行，理由比空闲更强：原始流是容器先攒满、宿主才轮得到加界的，
    // 上界不注入容器就等于没设——一条 `find /` 的输出能把沙箱撑死。与身份变量、空闲预算一样
    // 由平台给出，排在配置的环境变量之后。
    args.push('-e', `${TOOL_EXEC_MAX_OUTPUT_ENV}=${String(this.maxOutputBytes)}`)
    // 镜像名之后的位置参数会覆盖镜像的 `CMD`：entrypoint 的契约是 `entry.mjs <port> [host]`
    // （见 docker/entry.mjs），把配置的端口显式传下去，沙箱监听的端口才真的等于 `-p` 发布、
    // 也是 provider 拨号的那个端口；不传就等于把镜像 CMD 里的 8642 当成不可配置的事实。
    args.push(this.toolExecImage, String(this.toolExecPort))
    const result = await this.runCli(args, signal)
    if (result.exitCode !== 0) {
      throw new Error(`container-docker: '${name}' failed to start (exit ${result.exitCode}): ${result.stderr}`)
    }
    const port = await this.readPublishedPort(name, signal)
    const runtime: TenantRuntime = { name, port, expiresAt: Date.now() + this.sandboxCacheTtlMs }
    await this.waitReady(runtime, signal)
    return runtime
  }

  /** The stable, (tenant, user)-partitioned name of one subject's container. */
  private containerName(tenant: Tenant, user: UserId): string {
    return `dsh-${tenantPartitionName(tenant.id)}-${userPartitionName(user)}`
  }

  /**
   * Every bind mount one subject's sandbox is started with, in `docker run` order.
   *
   * The sources differ in owner: the first three belong to the (tenant, member)
   * pair, `/global` to the deployment's user root, `/tools` to the tenant, and the
   * Python environment to the deployment. Each is a host path the container
   * runtime resolves, so each must exist here first.
   *
   * @param tenant - the ambient tenant.
   * @param user - the ambient user.
   * @returns the mounts, each absent when its configuring field is absent.
   *
   * 这张挂载表与 `container-k8s` 是同一张：挂载点逐条相同，只有把挂载交给容器运行时的方式不同
   * （这里是 `-v`，那里是 Pod 的卷）。`/tools` 之外的每一层在两端都只来自配置，
   * 因此同一个部署切后端时不需要改这些根。
   *
   * 三层技能在两端也都各多挂一份到聚合根 `/opt/data/skills/<kind>`：案件脚本遍历那个根去发现
   * 技能，而一次挂载只能把一个来源放到一个位置，所以层与层之间只能靠子目录分开。
   *
   * 唯一一条 k8s 独有的挂载是聚合根本身：那里的挂载点是 Pod 卷，目标落在只读的 `/case`、
   * `/global` 里面就建不出来，所以那个后端另外挂一个容器本地可写目录当父目录。`docker -v`
   * 自己会造出缺失的目标目录，这里因此没有对应的一条。
   */
  private mounts(tenant: Tenant, user: UserId): MountSource[] {
    const SKILLS_ROOT = '/opt/data/skills'
    const caseReadOnly = this.caseReadOnly
    const usersReadOnly = this.usersReadOnly
    const userCase = `${tenant.workspaceRoot}/${TENANT_USERS_DIR_NAME}/${user}`
    const mounts: MountSource[] = [
      { source: `${userCase}/${TENANT_WORK_DIR_NAME}`, target: SANDBOX_WORKSPACE_MOUNT, readOnly: false },
      // 会话工作目录与用户案件工作目录平级：同层的话，挂载 `/workspace` 就等于顺带交出这个人
      // 所有会话的目录树。来源按人切，所以一个沙箱也看不到别人的会话。
      { source: `${userCase}/${TENANT_SESSIONS_DIR_NAME}`, target: SANDBOX_SESSIONS_MOUNT, readOnly: false },
      { source: `${tenant.workspaceRoot}/${TENANT_WORK_DIR_NAME}`, target: SANDBOX_CASE_MOUNT, readOnly: caseReadOnly },
      // 案件技能层报告的技能基目录是它自己的宿主目录，而技能正文让模型按该目录解析相对路径，
      // 所以那个路径在沙箱里也必须能解析到。同一个来源按两个路径挂是必要的，不是冗余。
      { source: `${tenant.workspaceRoot}/${TENANT_SKILL_DIR_NAME}`, target: `${tenant.workspaceRoot}/${TENANT_SKILL_DIR_NAME}`, readOnly: true },
    ]
    // Skills reach the sandbox as mounted tiers under one root the case scripts enumerate.
    // A mount carries one source to one path, so each tier keeps its own subdirectory and
    // the same skill name may appear in more than one. Names match `skill-tier`'s kinds.
    mounts.push({ source: `${tenant.workspaceRoot}/${TENANT_SKILL_DIR_NAME}`, target: `${SKILLS_ROOT}/case`, readOnly: true })
    if (this.usersRoot !== undefined) {
      mounts.push({ source: `${this.usersRoot}/${user}/${TENANT_WORK_DIR_NAME}`, target: '/global', readOnly: usersReadOnly })
      mounts.push({ source: `${this.usersRoot}/${user}/${TENANT_SKILL_DIR_NAME}`, target: `${SKILLS_ROOT}/user-global`, readOnly: true })
    }
    if (this.systemRoot !== undefined) {
      // Read-only at its own absolute path: skill bodies reach the model through the
      // host-side skill provider, but the companion files they cite are readable only
      // through the sandbox.
      mounts.push({ source: this.systemRoot, target: this.systemRoot, readOnly: true })
      mounts.push({ source: `${this.systemRoot}/${TENANT_SKILL_DIR_NAME}`, target: `${SKILLS_ROOT}/system`, readOnly: true })
    }
    // /tools 的来源规则：租户记录优先，缺省回落配置。一个 provider 实例服务所有租户，
    // 所以租户记录里写明的工具图谱就是那个租户自己的；配置里的那份供没写明的租户使用。
    const toolsRoot = tenant.toolsRoot ?? this.toolsRoot
    if (toolsRoot !== undefined) {
      mounts.push({ source: toolsRoot, target: '/tools', readOnly: true })
    }
    if (this.pythonEnv !== undefined) {
      // Read-only at its own absolute path, because the environment's scripts,
      // `pyvenv.cfg`, and `.pth` files name that path and the sandbox only reads it.
      mounts.push({ source: this.pythonEnv.root, target: this.pythonEnv.root, readOnly: true })
    }
    return mounts
  }

  /**
   * Refuse a start whose bind-mount sources this host does not have.
   *
   * The tenant and the member are known only here, and this host process is the
   * only party that can tell an absent directory from one the container runtime
   * would create, so this is the earliest point that can name what is missing for
   * whom.
   *
   * @param mounts - the mounts the start would hand the container runtime.
   * @param tenant - the tenant whose sandbox is starting.
   * @param user - the subject whose sandbox is starting.
   * @throws when a source is not an existing host directory, naming every missing
   *   source, its container path, and the (tenant, member) pair it belongs to.
   */
  private requireMountSources(mounts: readonly MountSource[], tenant: Tenant, user: UserId): void {
    const missing = mounts.filter(mount => !this.probe.isDirectory(mount.source))
    if (missing.length > 0) throw new Error(missingMountMessage(missing, tenant, user))
  }

  /**
   * The environment variables that put the host's Python environment in front of
   * the sandbox's own interpreter. Each follows its own probe: a directory
   * holding only `bin` gets `PATH` alone.
   *
   * @returns the `docker run -e` arguments for the mounted environment, empty when none is configured.
   */
  private pythonEnvironmentArgs(): string[] {
    const environment = this.pythonEnv
    if (environment === undefined) return []
    const args: string[] = []
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

  /**
   * Drop the cached sandbox for a subject and remove its container. A failed exec
   * reaches here: the next `ensure` starts a replacement.
   *
   * 空闲回收不在这里：一个沙箱有没有人用，只有沙箱自己看得见——每个请求都要到达容器，
   * 而宿主的缓存只是「我上次拿到的那个地址」，多副本部署下它看不见别的副本正在用的沙箱，
   * 按缓存计时就会删掉别人正在使唤的容器。容器各自按 `idleTimeoutMs` 自行退出
   * （见 `tool-exec.ts` 的空闲 watchdog），这里只负责丢句柄与收尾。
   *
   * @param key - the (tenant, user) scope key whose sandbox is being discarded.
   */
  private discard(key: string): void {
    const runtime = this.tenants.get(key)
    if (runtime === undefined) return
    this.tenants.delete(key)
    this.removeContainer(runtime.name)
  }

  /**
   * 收掉本 provider 标签下**已经退出**的容器：沙箱自己的空闲 watchdog 退出后留下的残骸，
   * 以及宿主非优雅退出时没来得及清理的那些。只删已退出的——正在运行的容器可能是另一个副本
   * 正在使用的沙箱，删它就是两个实例互相替换对方的工作。
   */
  private async reapTerminalContainers(): Promise<void> {
    const listed = await this.runCli([
      'ps', '-a', '--filter', `label=${MANAGED_LABEL}`, '--filter', 'status=exited', '-q',
    ])
    const ids = listed.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (ids.length === 0) return
    await this.runCli(['rm', '-f', ...ids])
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
