/**
 * Kubernetes 沙箱 provider 的运行期行为：沙箱内写进去的事实、句柄缓存与空闲回收、
 * 冷启动期限，以及「取消一次调用」与「取消一次共享启动」的区别。
 * 这些都是答错时只会悄悄出错、不会大声崩掉的决定，所以在这里钉死。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ContainerCommandResult, ContainerExecOptions, ContainerPtyOutcome } from '@deepseek-ai/dsh-container'
import type { ContainerCliRunner, ContainerPtyRunner, ContainerPtyTransport, ToolExecClient, ToolExecRequest, ToolExecResult } from '@deepseek-ai/dsh-container-transport'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import K8sContainerRuntime from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { sandboxPodName } from '../src/pod-spec.ts'

const TENANT: Tenant = {
  id: TenantId('sunce-1028'),
  name: 'sunce-1028',
  dataRoot: '/opt/dsh/tenants/sunce-1028',
  workspaceRoot: '/opt/dsh/tenants/sunce-1028/workspace',
}

/**
 * 覆盖项：允许显式传 `undefined`。构造即校验的用例要喂进去的正是“配了一半”的配置，
 * 而 `Partial<Config>` 在 `exactOptionalPropertyTypes` 下不允许显式传 `undefined`。
 */
type ConfigOverrides = { [K in keyof Config]?: Config[K] | undefined }

/** 默认配置叠上覆盖项；`as Config` 承接上面那处刻意的类型越界。 */
const config = (overrides: ConfigOverrides = {}): Config => ({
  namespace: 'dsh',
  image: 'dsh-tool-exec:latest',
  kubectlBinary: 'kubectl',
  imagePullPolicy: 'IfNotPresent',
  toolExecPort: 8642,
  usersRoot: '/opt/dsh/.dsh/users',
  systemRoot: '/opt/dsh/.dsh/system',
  toolsRoot: '/opt/dsh/tools',
  pythonRoot: '/opt/dsh/.dsh/pyenv',
  workspaceClaim: 'dsh-workspace',
  claimRoot: '/opt/dsh',
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

/** 假集群里一个已被创建的沙箱 Pod。 */
interface FakePod {
  /** `kubectl create -f -` 收到的清单。 */
  spec: string
  phase: string
  ready: boolean
  podIP?: string
}

/**
 * 一个带状态的假集群：`create` 造出一个 Running 且 Ready 的 Pod，`get pod` 把它读回来，
 * `delete` 把它清掉。这样 provider 的收养、替换、释放三条路径都会走到真实的返回值上。
 */
class FakeCluster implements ContainerCliRunner {
  readonly calls: string[][] = []
  /** 每次 `create` 收到的清单，按时间顺序。 */
  readonly specs: string[] = []
  /** 集群里的沙箱；null 表示不存在。 */
  pod: FakePod | null = null
  /** 每条调用都挂住，直到传进来的期限中止它——模拟一个不再作答的 apiserver。 */
  wedged = false
  /** `create` 之前的延迟，用来让一次启动在调用方取消时仍处于进行中。 */
  createDelayMs = 0
  /** 让 `create` 报 AlreadyExists，并留下赢家建出来的沙箱——模拟两个实例同时创建。 */
  conflictOnCreate = false
  /** `create` 造出的 Pod 的阶段：设成 Pending 就得到一个永远起不来的沙箱。 */
  createPhase = 'Running'
  /** 集群为沙箱记下的事件：替换一个终态沙箱时，provider 会把这些话读出来当作死因。 */
  events: { type?: string; reason?: string; message?: string }[] = []
  /** `create` 造出的 Pod 是否 Ready。 */
  createReady = true

  async run(args: readonly string[], opts?: ContainerExecOptions): Promise<ContainerCommandResult> {
    this.calls.push([...args])
    if (this.wedged) {
      return await new Promise<ContainerCommandResult>((resolve) => {
        // 生产里的 runner 在期限到点时杀掉子进程，并把它报成退出码 0；
        // 这里保持同样的可观测行为，让被放弃的调用确实 settle。
        opts?.signal?.addEventListener('abort', () => { resolve({ exitCode: 0, stdout: '', stderr: '' }) }, { once: true })
      })
    }
    const verb = args[2]
    const kind = args[3]
    if (verb === 'create') {
      if (this.createDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.createDelayMs))
      if (this.pod) return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): pods already exists' }
      this.specs.push(opts?.stdin ?? '')
      this.pod = { spec: opts?.stdin ?? '', phase: this.createPhase, ready: this.createReady, podIP: '10.0.0.9' }
      if (this.conflictOnCreate) {
        // 另一个实例先创建成功了：这个 Pod 就是它建出来的那个，本次调用输掉了创建。
        return { exitCode: 1, stdout: '', stderr: 'Error from server (AlreadyExists): pods already exists' }
      }
      return { exitCode: 0, stdout: 'created', stderr: '' }
    }
    if (verb === 'get' && kind === 'pod') {
      if (!this.pod) return { exitCode: 1, stdout: '', stderr: 'Error from server (NotFound): pods not found' }
      return { exitCode: 0, stdout: JSON.stringify(podDocument(this.pod)), stderr: '' }
    }
    if (verb === 'get' && kind === 'events') return { exitCode: 0, stdout: JSON.stringify({ items: this.events }), stderr: '' }
    if (verb === 'delete') {
      // 只有字段选择器点名的阶段才真的被删掉：生产里的收尸只碰终态 Pod，假集群也要照这条走，
      // 否则「收养一个正在跑的沙箱」这类用例会被一次收尸悄悄清空。
      const selector = args.find(part => part.startsWith('status.phase='))
      const phase = selector?.slice('status.phase='.length)
      const deleted = phase === undefined || phase === this.pod?.phase
      if (deleted) this.pod = null
      // kubectl 每删掉一个 Pod 打一行 `pod "<名字>" deleted`；收尸那句日志就靠它报出删了什么。
      return { exitCode: 0, stdout: deleted ? `pod "${sandboxPodName('sunce-1028', 'investigator-1')}" deleted\n` : '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /** 这个集群里的沙箱被建过几次。 */
  creates(): number { return this.specs.length }

  /** 按 Pod 读状态的调用次数。 */
  reads(): number { return this.calls.filter(c => c[2] === 'get' && c[3] === 'pod').length }

  /** 删除 Pod 的调用次数；收尸用的是 `-l` 选择器，不算一次「删掉某个沙箱」。 */
  deletes(): number { return this.calls.filter(c => c[2] === 'delete' && !c.includes('-l')).length }
}

/** 把假 Pod 渲染成 `kubectl get pod -o json` 的文档。 */
function podDocument(pod: FakePod): Record<string, unknown> {
  return {
    metadata: { name: 'x', annotations: { 'dsh.dev/spec-fingerprint': fingerprintOf(pod.spec) } },
    status: {
      phase: pod.phase,
      ...(pod.podIP ? { podIP: pod.podIP } : {}),
      conditions: [{ type: 'Ready', status: pod.ready ? 'True' : 'False' }],
    },
  }
}

/** 从一份清单里读回它记录的 spec 指纹。 */
function fingerprintOf(spec: string): string | undefined {
  try {
    return (JSON.parse(spec) as { metadata: { annotations: Record<string, string> } }).metadata.annotations['dsh.dev/spec-fingerprint']
  } catch {
    return undefined
  }
}

/**
 * `container-transport` 投进程组信号的真实 argv：绝对路径的 `/bin/sh` 跑它自己的
 * `kill` 内建，信号名与进程组作为位置参数传入（进程组以负操作数寻址，只有内建接受）。
 */
const SIGNAL_COMMAND = '/bin/sh'
const SIGNAL_PROGRAM = 'kill -s "${1#SIG}" -- "-$2"'

/** 这条请求是不是一次信号投递，而不是就绪探测或一条普通命令。 */
function isSignalRequest(req: ToolExecRequest): boolean {
  return req.argv[0] === SIGNAL_COMMAND && req.argv[2] === SIGNAL_PROGRAM
}

/** 假的 tool-exec 客户端：记下每个请求，并让命令请求按需失败或挂起一次。 */
class FakeClient implements ToolExecClient {
  readonly requests: { baseUrl: string; req: ToolExecRequest }[] = []
  /** 还需要失败几次的命令请求（就绪探测不算）。 */
  failures = 0
  /** 设置后，`argv[0]` 与 `program` 相同的命令会挂到 `gate` 完成为止。 */
  hold: { program: string; gate: Promise<void> } | undefined
  /** 这个沙箱里的交互式会话：一次信号投递结束它，此后进程表读不到活着的进程组。 */
  pty: FakePtyRunner | undefined

  async exec(baseUrl: string, req: ToolExecRequest): Promise<ToolExecResult> {
    this.requests.push({ baseUrl, req })
    // 会话里的进程组被 provider 投了信号时，沙箱里的 CLI 也随之退出。
    if (isSignalRequest(req)) this.pty?.kill()
    // 就绪探测永远答得上话：这些用例测的是命令自己的失败，不是沙箱起不来。
    if (req.argv[0] === 'sh') {
      // 交互式会话的身份探测：报一个活着的会话，以及带头的那一组。
      if (req.argv.join(' ').includes('DSH_PTY_MEMBER')) {
        const alive = this.pty === undefined || this.pty.alive
        return { exitCode: 0, stdout: alive ? 'DSH_PTY_MEMBER 42 42\nDSH_PTY_LEADER 42 42\n' : '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const held = this.hold
    if (held !== undefined && held.program === req.argv[0]) await held.gate
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('fetch failed')
    }
    return { exitCode: 0, stdout: 'ok', stderr: '' }
  }

  /** 发给沙箱的命令请求（不含就绪探测与信号投递），按时间顺序。 */
  commands(): ToolExecRequest[] {
    return this.requests.filter(r => r.req.argv[0] !== 'sh' && !isSignalRequest(r.req)).map(r => r.req)
  }
}

/** 一套装好的 provider 加它的两个假接缝；传入已有的集群可以模拟服务同一主体的另一个 host 实例。 */
function harness(overrides: Partial<Config> = {}, cluster = new FakeCluster()) {
  const client = new FakeClient()
  const ctx = new Context()
  const rt = new K8sContainerRuntime(ctx, config(overrides), cluster, client)
  return { rt, cluster, client, logs: captureLogs(ctx) }
}

/** 一条被记下来的日志：格式串与它收到的参数分开留着，断言因此能钉住两句各自的内容。 */
interface CapturedLog {
  format: string
  args: unknown[]
}

/**
 * 记下 provider 通过 `ctx.logger` 说出来的每一句。
 *
 * 沙箱的生命周期（创建、收养、替换、收尸）在别的组件里都看不见：Pod 由这个 provider 按需创建，
 * 而这些事实只存在于内存与集群里。日志是运维唯一的出口，所以它的内容值得被钉住。
 */
function captureLogs(ctx: Context): { infos: CapturedLog[]; warns: CapturedLog[] } {
  const infos: CapturedLog[] = []
  const warns: CapturedLog[] = []
  const record = (into: CapturedLog[]) => (...args: unknown[]) => {
    into.push({ format: String(args[0]), args: args.slice(1) })
  }
  ctx.logger.info = record(infos) as typeof ctx.logger.info
  ctx.logger.warn = record(warns) as typeof ctx.logger.warn
  return { infos, warns }
}

/** 在某个租户的 (租户, 用户) 作用域里执行一条命令。 */
function execAs(rt: K8sContainerRuntime, tenant: Tenant, argv: string[] = ['echo', 'hi'], signal?: AbortSignal): Promise<ContainerCommandResult> {
  return runWithTenant(tenant, () => runWithUser(UserId('investigator-1'), () =>
    rt.exec(argv[0] as string, argv.slice(1), signal === undefined ? undefined : { signal })))
}

/** 在默认租户作用域里执行一条命令。 */
const execOnce = (rt: K8sContainerRuntime, argv?: string[], signal?: AbortSignal): Promise<ContainerCommandResult> =>
  execAs(rt, TENANT, argv, signal)

/** 在默认租户作用域里执行一条带执行选项的命令：会话工作目录按 `opts.env` 里的会话 id 解析。 */
const execWith = (rt: K8sContainerRuntime, opts: ContainerExecOptions, argv: string[] = ['echo', 'hi']): Promise<ContainerCommandResult> =>
  runWithTenant(TENANT, () => runWithUser(UserId('investigator-1'), () => rt.exec(argv[0] as string, argv.slice(1), opts)))

/** 等一小段真实时间，让计时器到点。 */
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 从一份清单里读出沙箱容器的环境变量。 */
function envOf(spec: string): Record<string, string> {
  const parsed = JSON.parse(spec) as { spec: { containers: { env: { name: string; value: string }[] }[] } }
  return Object.fromEntries(parsed.spec.containers[0]!.env.map(e => [e.name, e.value]))
}

/** 从一份清单里读出某个挂载点在沙箱内的来源（claim 模式下的 `subPath`）。 */
function subPathOf(spec: string, mountPath: string): string | undefined {
  const parsed = JSON.parse(spec) as { spec: { containers: { volumeMounts: { mountPath: string; subPath?: string }[] }[] } }
  return parsed.spec.containers[0]!.volumeMounts.find(m => m.mountPath === mountPath)?.subPath
}

/** 从一份清单里读出沙箱容器的命令。 */
function commandOf(spec: string): string[] {
  const parsed = JSON.parse(spec) as { spec: { containers: { command: string[] }[] } }
  return parsed.spec.containers[0]!.command
}

/**
 * 按 Loader 的方式（`vendor/cordis/src/fiber.ts` 的 `resolveConfig`）过一遍 schema：
 * 校验失败就抛，成功则返回补好默认值的配置。
 */
function apply(raw: unknown): unknown {
  const result = K8sContainerRuntime.Config['~standard'].validate(raw)
  if ('then' in result) throw new Error('async config validation is not supported')
  if (result.issues) throw new Error(JSON.stringify(result.issues))
  return result.value
}

describe('插件协议', () => {
  it('keeps the schema on the class, so the Loader applies its defaults and bounds', () => {
    // Cordis 从 `plugin.Config` 取 schema（vendor/cordis/src/registry.ts），对默认导出的类插件
    // 就是类的静态成员。schema 不在那里时 Loader 直接放行原配置：默认值、`z.natural().min(1)`
    // 都静默失效，拼错的字段名也不再被拒。这个用例就是那道回归防线。
    expect(K8sContainerRuntime.Config).toBeDefined()
    expect(apply({ namespace: 'ns', image: 'img' })).toMatchObject({
      kubectlBinary: 'kubectl',
      imagePullPolicy: 'IfNotPresent',
      toolExecPort: 8642,
      command: ['node', 'entry.mjs'],
      cliTimeoutMs: 60_000,
      startTimeoutMs: 180_000,
      statusPollMs: 500,
      readyTimeoutMs: 10_000,
      readyPollMs: 30,
      transportTimeoutMs: 600_000,
      sandboxCacheTtlMs: 5_000,
      maxOutputBytes: 67_108_864,
    })
    expect(() => apply({ namespace: 'ns', image: 'img', toolExecPort: 0 })).toThrow()
  })
})

describe('跨 host 实例的沙箱归属', () => {
  it('adopts a running sandbox built from this host spec instead of replacing it', async () => {
    const cluster = new FakeCluster()
    await execOnce(harness({}, cluster).rt)
    // 服务同一 (租户, 用户) 的第二个实例必须复用这个运行中的沙箱：
    // 删掉它等于拆掉另一个实例正在做的事，每次 host 重启也都会丢掉所有已经热的沙箱。
    await execOnce(harness({}, cluster).rt)
    expect(cluster.specs).toHaveLength(1)
    expect(cluster.deletes()).toBe(0)
  }, 30000)

  it('refuses to replace a sandbox built from a different spec', async () => {
    const cluster = new FakeCluster()
    cluster.pod = { spec: '{"kind":"Pod"}', phase: 'Running', ready: true, podIP: '10.0.0.9' }
    // 两个实例对 spec 的理解不一致时，它们会互相不停替换对方的沙箱。这属于部署故障，
    // 所以报出来，且不去动那个正在运行的沙箱。
    await expect(execOnce(harness({}, cluster).rt)).rejects.toThrow(/runs a different spec/)
    expect(cluster.deletes()).toBe(0)
    expect(cluster.creates()).toBe(0)
  }, 30000)

  it('adopts the winner when two instances create the same sandbox concurrently', async () => {
    const cluster = new FakeCluster()
    cluster.conflictOnCreate = true
    const { rt, logs } = harness({}, cluster)
    // 输掉创建的那个实例收养赢家建出来的沙箱，而不是报一个调用方无能为力的失败。
    await expect(execOnce(rt)).resolves.toMatchObject({ exitCode: 0 })
    // 它没有创建任何一个沙箱，日志里也不该说它创建了。
    expect(logs.infos).toEqual([
      {
        format: 'container-k8s: lost the creation race for sandbox %s (tenant %s, subject %s); adopting the winner',
        args: [sandboxPodName('sunce-1028', 'investigator-1'), 'sunce-1028', 'investigator-1'],
      },
    ])
  }, 30000)
})

describe('沙箱生命周期的日志', () => {
  it('records the sandbox it created, with the bound that applied to it', async () => {
    const bounded = harness({ memoryLimit: '6Gi' })
    await execOnce(bounded.rt)
    // 沙箱按需创建、又在别的组件里看不见，所以创建事实与这一次生效的上界一起进日志：
    // 事后查「它为什么被节点杀掉」时，这是唯一的起点。
    expect(bounded.logs.infos).toEqual([
      {
        format: 'container-k8s: created sandbox %s for tenant %s subject %s (image %s, %s)',
        args: [sandboxPodName('sunce-1028', 'investigator-1'), 'sunce-1028', 'investigator-1', 'dsh-tool-exec:latest', 'limits {"memory":"6Gi"}'],
      },
    ])

    const unbounded = harness()
    await execOnce(unbounded.rt)
    expect(unbounded.logs.infos[0]?.args[4]).toBe('no resource limits')
  })

  it('records the sandbox it adopted instead of building a fresh one', async () => {
    const first = harness()
    await execOnce(first.rt)
    const second = harness({}, first.cluster)
    await execOnce(second.rt)
    // 之后每一条命令都落在这个沙箱上，而这条对应关系只存在于内存里。
    expect(second.logs.infos).toEqual([
      {
        format: 'container-k8s: adopting sandbox %s for tenant %s subject %s (phase %s)',
        args: [sandboxPodName('sunce-1028', 'investigator-1'), 'sunce-1028', 'investigator-1', 'Running'],
      },
    ])
  })

  it('records the death of the sandbox it replaces, with the events behind it', async () => {
    const first = harness()
    await execOnce(first.rt)
    first.cluster.pod!.phase = 'Failed'
    first.cluster.events = [{ type: 'Warning', reason: 'OOMKilling', message: 'Memory cgroup out of memory' }]
    const second = harness({}, first.cluster)
    await execOnce(second.rt)
    // 替换本身不报错，死因只出现在集群事件里：不记下来，宿主日志对一个消失的沙箱完全沉默。
    expect(second.logs.warns).toEqual([
      {
        format: 'container-k8s: replacing sandbox %s for tenant %s subject %s: it is in phase %s%s',
        args: [
          sandboxPodName('sunce-1028', 'investigator-1'),
          'sunce-1028',
          'investigator-1',
          'Failed',
          '; events: Warning OOMKilling: Memory cgroup out of memory',
        ],
      },
    ])

    // 集群没有留下事件时替换照样发生，只是日志里少一句死因。
    first.cluster.events = []
    first.cluster.pod!.phase = 'Failed'
    const third = harness({}, first.cluster)
    await execOnce(third.rt)
    expect(third.logs.warns[0]?.args[4]).toBe('')
  })

  it('reports the terminal sandboxes it reaped at startup', async () => {
    const cluster = new FakeCluster()
    cluster.pod = { spec: '', phase: 'Failed', ready: false }
    const { logs } = harness({}, cluster)
    await settle(20)
    // 收尸发生在上一次宿主进程结束之后，没有别的记录：说出删掉了哪些、停在哪个阶段，
    // 才知道一个沙箱是自己空闲退出还是被节点杀掉。
    expect(logs.infos).toEqual([
      {
        format: 'container-k8s: reaped %d terminal sandbox pod(s) in phase %s: %s',
        args: [1, 'Failed', `pod "${sandboxPodName('sunce-1028', 'investigator-1')}" deleted`],
      },
    ])
  })
})

describe('沙箱内写进去的事实', () => {
  it('hands the configured tool-exec port to the image entrypoint', async () => {
    const { rt, cluster } = harness({ toolExecPort: 9000 })
    await execOnce(rt)
    // Pod 一旦写了 command，镜像 CMD 就不再生效：端口只能由 provider 显式传下去，
    // 否则沙箱监听镜像 CMD 里的端口，而 provider 按配置的端口拨号，永远拨不通。
    expect(commandOf(cluster.specs[0]!)).toEqual(['node', 'entry.mjs', '9000'])
  })

  it('states the identity variables and the declared Python triple in the Pod environment', async () => {
    const { rt, cluster } = harness({
      pythonEnv: {
        binDir: '/opt/dsh/.dsh/pyenv/bin',
        virtualEnv: '/opt/dsh/.dsh/pyenv',
        sitePackages: '/opt/dsh/.dsh/pyenv/lib/python3.11/site-packages',
      },
      toolExecImagePath: '/image/bin',
    })
    await execOnce(rt)
    const env = envOf(cluster.specs[0]!)

    // 身份事实由平台给出：Pod 名与 /case 目录名都是推不出「哪个案子、哪个人」的把手。
    expect(env.DSH_CASE_ID).toBe('sunce-1028')
    expect(env.DSH_TENANT_ID).toBe('sunce-1028')
    expect(env.DSH_USER_ID).toBe('investigator-1')
    // Python 三件套与 container-docker 是同一组变量、同一套取值规则，只是取值由部署声明。
    expect(env.PATH).toBe('/opt/dsh/.dsh/pyenv/bin:/image/bin')
    expect(env.VIRTUAL_ENV).toBe('/opt/dsh/.dsh/pyenv')
    expect(env.PYTHONPATH).toBe('/opt/dsh/.dsh/pyenv/lib/python3.11/site-packages')
  })

  it('sets only the Python variables whose own field is present', async () => {
    const { rt, cluster } = harness({ pythonEnv: { binDir: '/opt/py/bin' } })
    await execOnce(rt)
    const env = envOf(cluster.specs[0]!)
    expect(env.PATH).toBe('/opt/py/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    expect(env.VIRTUAL_ENV).toBeUndefined()
    expect(env.PYTHONPATH).toBeUndefined()
  })

  it('keeps a configured environment variable from overriding the identity facts', async () => {
    const { rt, cluster } = harness({ env: { DSH_USER_ID: 'someone-else', EXTRA: 'kept' } })
    await execOnce(rt)
    const env = envOf(cluster.specs[0]!)
    expect(env.DSH_USER_ID).toBe('investigator-1')
    expect(env.EXTRA).toBe('kept')
  })

  it('points library caches at the writable /tmp the Pod mounts, and lets the deployment override it', async () => {
    const plain = harness()
    await execOnce(plain.rt)
    // 根文件系统只读，而 HOME 是 /root：按默认位置写缓存的库每次都拿到 EROFS，matplotlib 会因此
    // 在每一条用到它的命令输出里插一段警告并退回临时目录。Pod 自己挂的 /tmp 是唯一保证可写的位置。
    expect(envOf(plain.cluster.specs[0]!).MPLCONFIGDIR).toBe('/tmp/matplotlib')

    const overridden = harness({ env: { MPLCONFIGDIR: '/opt/cache' } })
    await execOnce(overridden.rt)
    // 缓存位置是部署可以改的，所以它排在身份事实之前：给了同名项就听它的。
    expect(envOf(overridden.cluster.specs[0]!).MPLCONFIGDIR).toBe('/opt/cache')
  })

  it('takes /tools from the tenant record and falls back to the configured root', async () => {
    const configured = harness()
    await execOnce(configured.rt)
    // 租户记录没写 toolsRoot，于是配置里的那个根就是它的 /tools；沙箱内路径仍然是 /tools。
    expect(subPathOf(configured.cluster.specs[0]!, '/tools')).toBe('tools')

    const perTenant = harness()
    await execAs(perTenant.rt, { ...TENANT, toolsRoot: '/opt/dsh/tenants/sunce-1028/tools' })
    expect(subPathOf(perTenant.cluster.specs[0]!, '/tools')).toBe('tenants/sunce-1028/tools')
  })
})

describe('沙箱生命周期', () => {
  it('reuses a resolved sandbox handle instead of reading the cluster on every call', async () => {
    const { rt, cluster } = harness()
    await execOnce(rt)
    const afterFirst = cluster.reads()
    await execOnce(rt)
    // 每次工具调用都要解析沙箱；每次都去问集群，等于每次调用都花掉一个 kubectl 进程
    // 和一次 API server 往返。
    expect(cluster.reads()).toBe(afterFirst)
    expect(cluster.creates()).toBe(1)
  }, 30000)

  it('re-reads the cluster once the handle TTL expired instead of trusting it forever', async () => {
    const { rt, cluster } = harness({ sandboxCacheTtlMs: 20 })
    await execOnce(rt)
    const afterFirst = cluster.reads()
    await settle(60)
    await execOnce(rt)
    expect(cluster.reads()).toBeGreaterThan(afterFirst)
    // 过期只是重新确认，不是重建：沙箱还在跑就继续用它。
    expect(cluster.creates()).toBe(1)
  }, 30000)

  it('coalesces concurrent resolutions of one sandbox into a single cluster read', async () => {
    const single = harness()
    await execOnce(single.rt)
    const baseline = single.cluster.reads()

    const { rt, cluster } = harness()
    // 同一用户的多个会话同时发问：它们必须共用一次解析，而不是各自对着同一个沙箱再来一遍。
    await Promise.all([execOnce(rt), execOnce(rt), execOnce(rt)])
    expect(cluster.reads()).toBe(baseline)
    expect(cluster.creates()).toBe(1)
  }, 30000)

  it('injects the idle budget into the sandbox, which enforces it itself', async () => {
    const { rt, cluster } = harness({ idleTimeoutMs: 90_000 })
    await execOnce(rt)
    // 宿主不自己计时：看不见别的副本对这个沙箱的使用，而每一个请求都要到达容器。
    expect(envOf(cluster.specs[0] as string).DSH_TOOL_EXEC_IDLE_MS).toBe('90000')
  }, 30000)

  it('injects no idle budget when the config leaves it unset', async () => {
    const { rt, cluster } = harness()
    await execOnce(rt)
    // 省略即「沙箱永不自行退出」，而不是注入一个别的默认值。
    expect(envOf(cluster.specs[0] as string).DSH_TOOL_EXEC_IDLE_MS).toBeUndefined()
  }, 30000)

  it('injects the output bound into the sandbox, which enforces it itself', async () => {
    const { rt, cluster } = harness({ maxOutputBytes: 4096 })
    await execOnce(rt)
    // 原始流是容器先攒满、宿主才轮得到加界的：上界不注入沙箱就等于没设。
    expect(envOf(cluster.specs[0] as string).DSH_TOOL_EXEC_MAX_OUTPUT_BYTES).toBe('4096')
  }, 30000)

  it('injects the default output bound when the config leaves it unset', async () => {
    const { rt, cluster } = harness()
    await execOnce(rt)
    // 与空闲预算不同，这条上界总有一个值：省略配置不等于「不加界」。
    expect(envOf(cluster.specs[0] as string).DSH_TOOL_EXEC_MAX_OUTPUT_BYTES).toBe('67108864')
  }, 30000)

  it('deletes a sandbox that never becomes ready within the start deadline', async () => {
    const { rt, cluster } = harness({ startTimeoutMs: 40, statusPollMs: 5 })
    cluster.createPhase = 'Pending'
    cluster.createReady = false
    await expect(execOnce(rt)).rejects.toThrow(/did not finish within 40ms/)
    // 删除发生在启动失败之后，可能比报错晚一拍：等它落地。
    await settle(40)
    // 起不来的沙箱对任何实例都不可用：留着它只会永久占住这个 (租户, 用户)，每次重试都重新收养
    // 同一个坏掉的 Pod；裸 Pod 没有控制器，不删就没有任何东西会收走它。
    expect(cluster.deletes()).toBe(1)
    expect(cluster.pod).toBeNull()
    cluster.createPhase = 'Running'
    cluster.createReady = true
    await execOnce(rt)
    expect(cluster.creates()).toBe(2)
  }, 30000)

  it('fails a start that outlives startTimeoutMs and cold-starts the next exec', async () => {
    const { rt, cluster } = harness({ startTimeoutMs: 40, cliTimeoutMs: 300 })
    cluster.wedged = true
    await expect(execOnce(rt)).rejects.toThrow(/did not finish within 40ms/)

    // 失败不留缓存：下一次 exec 必须自己重新冷启动，而不是接上同一个永不 settle 的启动。
    cluster.wedged = false
    await execOnce(rt)
    expect(cluster.creates()).toBe(1)
  }, 30000)

  it('discards a sandbox whose tool-exec server stopped answering and retries once on a fresh one', async () => {
    const { rt, cluster, client } = harness()
    await execOnce(rt)
    client.failures = 1
    await execOnce(rt)
    // 传输失败意味着那个沙箱可能已经不在了（被驱逐、沙箱自己的空闲回收退出、host 重启）：
    // 丢掉它，在新沙箱上把同一条请求跑完，而不是把「沙箱不可达」抛给主体。
    expect(cluster.deletes()).toBe(1)
    expect(cluster.creates()).toBe(2)
    expect(client.commands().at(-1)?.argv).toEqual(['echo', 'hi'])
  }, 30000)

  it('detaches a cancelled caller without cancelling the start its peer is waiting on', async () => {
    const { rt, cluster } = harness()
    cluster.createDelayMs = 100
    const controller = new AbortController()
    const cancelled = execOnce(rt, ['echo', 'hi'], controller.signal)
    // 同一主体的第二个调用方，共用这次还在进行中的启动。
    const peer = execOnce(rt)
    await settle(20)
    controller.abort(new Error('caller gave up'))

    await expect(cancelled).rejects.toThrow('caller gave up')
    await expect(peer).resolves.toMatchObject({ exitCode: 0 })
    expect(cluster.creates()).toBe(1)
  }, 30000)

  it('reaps terminal sandboxes of its own label at startup, and only those', async () => {
    const { cluster } = harness()
    await settle(20)
    // 沙箱自己的空闲 watchdog 退出后留下终态 Pod，宿主非优雅退出也会留下残骸：启动时收掉它们。
    // 下手的是「按标签 + 字段选择器」，所以这里的断言就是那条命令：只碰终态阶段，Running/Pending
    // 的 Pod 可能是另一个副本正在用的沙箱，删它就是两个实例互相替换对方的工作。
    const sweeps = cluster.calls.filter(call => call[2] === 'delete')
    expect(sweeps.map(args => args.slice(2).join(' '))).toEqual([
      'delete pod -l dsh.dev/managed=true --field-selector status.phase=Succeeded --ignore-not-found --wait=false',
      'delete pod -l dsh.dev/managed=true --field-selector status.phase=Failed --ignore-not-found --wait=false',
    ])
  }, 30000)
})

describe('会话工作目录', () => {
  it('runs each session under its own directory on the mounted session root', async () => {
    const { rt, cluster, client } = harness()
    await execWith(rt, { env: { DSH_SESSION_ID: 'session-cdb4d064' } })
    // 会话目录建在挂载进来的会话根上。容器本地的 workDir 两件事都做不到：
    // 沙箱消失时它会连会话的产出一起消失，而且同一个人的所有会话共用同一层。
    expect(client.commands().map(r => r.argv)).toEqual([
      ['mkdir', '-p', '/sessions/session-cdb4d064'],
      ['echo', 'hi'],
    ])
    const command = client.commands()[1]!
    expect(command.cwd).toBe('/sessions/session-cdb4d064')
    // 技能按 DSH_WORKDIR 认领自己该往哪写，所以它与真正的工作目录必须是同一个值。
    expect(command.env?.DSH_WORKDIR).toBe('/sessions/session-cdb4d064')
    expect(cluster.creates()).toBe(1)
  })

  it('creates the directory once per session, not once per command', async () => {
    const { rt, client } = harness()
    await execWith(rt, { env: { DSH_SESSION_ID: 'session-a' } })
    await execWith(rt, { env: { DSH_SESSION_ID: 'session-a' } })
    // 第二条命令照样落在那个目录里，但不该再跑一次 mkdir：目录已经在磁盘上了。
    expect(client.commands().map(r => r.argv)).toEqual([
      ['mkdir', '-p', '/sessions/session-a'],
      ['echo', 'hi'],
      ['echo', 'hi'],
    ])

    // 另一个会话有它自己的一层，第一次用它时照样要建。
    await execWith(rt, { env: { DSH_SESSION_ID: 'session-b' } })
    expect(client.commands().at(-2)!.argv).toEqual(['mkdir', '-p', '/sessions/session-b'])
  })

  it('keeps the caller working directory when the exec carries no session', async () => {
    const { rt, client } = harness()
    // 探针与宿主自己的工具调用没有会话：这时唯一说得通的目录就是调用方给的那个。
    await execWith(rt, { cwd: '/tmp', env: { EXTRA: 'kept' } })
    expect(client.commands().map(r => r.argv)).toEqual([['echo', 'hi']])
    expect(client.commands()[0]!.cwd).toBe('/tmp')
    expect(client.commands()[0]!.env).toEqual({ EXTRA: 'kept' })
  })

  it('refuses a session id that is not a plain directory name', async () => {
    const { rt, client } = harness()
    // 会话 id 直接成为路径分量：能跳出工作目录的值一律不进沙箱，命令退回调用方的工作目录。
    await execWith(rt, { env: { DSH_SESSION_ID: '../../etc' } })
    expect(client.commands().map(r => r.argv)).toEqual([['echo', 'hi']])
    expect(client.commands()[0]!.cwd).toBeUndefined()
  })
})

describe('构造即校验', () => {
  // 构造即校验：配置错必须在加载时失败，而不是等到第一次建沙箱。
  // 收尸那条 kubectl 调用是构造时唯一会跑出去的异步工作，这里也注入假 runner：不注入就等于
  // 让这个纯配置校验块去起真 kubectl 打真集群，既慢又依赖跑测试的机器上有没有 kubeconfig。
  const build = (overrides: ConfigOverrides): K8sContainerRuntime =>
    new K8sContainerRuntime(new Context(), config(overrides), new FakeCluster())

  it('refuses the namespaces every cluster owns', () => {
    for (const namespace of ['default', 'kube-system', 'kube-public', 'kube-node-lease']) {
      expect(() => build({ namespace })).toThrow(/belongs to the cluster itself/)
    }
  })

  it('leaves every other name to the deployment, business namespaces included', () => {
    // 包不对具体集群的名字下判断：那台集群上哪个命名空间属于谁，只有部署知道。
    // 名字配错时的隔离由集群侧承担——host 的 SA 只有目标命名空间里的 Role。
    expect(() => build({ namespace: 'znjj-middleware' })).not.toThrow()
    expect(() => build({ namespace: 'dsh' })).not.toThrow()
  })

  it('refuses a half-configured claim instead of silently falling back to hostPath', () => {
    expect(() => build({ claimRoot: undefined })).toThrow(/must be set together/)
    expect(() => build({ workspaceClaim: undefined })).toThrow(/must be set together/)
  })

  it('refuses a Python environment description with nothing to describe', () => {
    expect(() => build({ pythonRoot: undefined, pythonEnv: { binDir: '/opt/py/bin' } }))
      .toThrow(/pythonEnv requires Config.pythonRoot/)
  })
})

/** 只记录 argv、只回答握手的交互式终端接缝：真实 TTY 由 host 分配，容器侧要验的是装配。 */
class FakePtyRunner implements ContainerPtyRunner {
  readonly starts: { args: readonly string[]; rows: number; cols: number; graceMs: number }[] = []
  /** 沙箱里那个会话的进程组是否还在跑；`kill()` 之后沙箱也读不到它。 */
  alive = true

  private ended: ((outcome: ContainerPtyOutcome) => void) | undefined

  async start(args: readonly string[], spec: { rows: number; cols: number; graceMs: number }): Promise<ContainerPtyTransport> {
    this.starts.push({ args, ...spec })
    const listeners = new Set<(data: string) => void>()
    const done = new Promise<ContainerPtyOutcome>((resolve) => { this.ended = resolve })
    return {
      pid: 1,
      done,
      onData: (listener: (data: string) => void): (() => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      async write(data: string): Promise<void> {
        if (!data.includes('DSH_PTY_SESSION')) return
        for (const listener of listeners) listener('DSH_PTY_SESSION 42\r\nbash-5.2# ')
      },
      // CLI 随会话结束而退出：假的也照这条结算 `done`，否则等它的关闭方会一直等下去。
      terminate: async (): Promise<void> => {
        this.kill()
      },
    }
  }

  /** 结束会话的进程组，也就是 CLI 随会话退出那件事。 */
  kill(): void {
    this.alive = false
    this.ended?.({ exitCode: 0, signal: 'SIGTERM' })
  }
}

describe('交互式会话', () => {
  it('在沙箱 Pod 里开一个带 TTY 的 exec，身份探测走同一个沙箱', async () => {
    const runner = new FakePtyRunner()
    const client = new FakeClient()
    client.pty = runner
    const rt = new K8sContainerRuntime(new Context(), config(), new FakeCluster(), client, runner)
    const session = await runWithTenant(TENANT, () => runWithUser(UserId('investigator-1'), () =>
      rt.openPty({ command: 'bash', rows: 24, cols: 80, maxOutputBytes: 4_096, disposeGraceMs: 500 })))

    expect(runner.starts).toEqual([{
      args: ['-n', 'dsh', 'exec', '-i', '-t', sandboxPodName('sunce-1028', 'investigator-1'), '--', 'bash'],
      rows: 24,
      cols: 80,
      graceMs: 500,
    }])
    // 会话号与进程组来自沙箱自己的进程表，而不是 kubectl 的输出。
    expect(session.pid).toBe(42)
    expect(client.requests.some(request =>
      request.req.argv[0] === 'sh' && request.req.argv.join(' ').includes('DSH_PTY_MEMBER'))).toBe(true)

    // 用例开的会话由用例关掉：留着它就是把这个终端的进程和它的期限一起交给后面的用例。
    await expect(session.close('the test is done with this terminal')).resolves.toBeUndefined()
    // 关闭走真实投递契约：程序文本认得出来，且带上探测读出的那一组与 SIGTERM。
    expect(client.requests.filter(request => isSignalRequest(request.req))
      .map(request => request.req.argv.slice(-2))).toEqual([['SIGTERM', '42']])
    await expect(session.done).resolves.toEqual({ exitCode: 0, signal: 'SIGTERM' })
  })
})

describe('沙箱资源上限', () => {
  it('把配置的内存与 CPU 上限写进沙箱容器的 limits', async () => {
    const cluster = new FakeCluster()
    await execOnce(harness({ memoryLimit: '8Gi', cpuLimit: 2 }, cluster).rt)
    const containers = (JSON.parse(cluster.specs[0]!) as { spec: { containers: { resources?: unknown }[] } }).spec.containers
    // 只声明 limits：等额的 requests 会把这份内存从节点上永久预留出去，而沙箱是逐个突发起来的。
    expect(containers[0]!.resources).toEqual({ limits: { memory: '8Gi', cpu: '2' } })
  }, 30000)

  it('不配上限时不声明 resources，Pod 落在 BestEffort', async () => {
    const cluster = new FakeCluster()
    await execOnce(harness({}, cluster).rt)
    const containers = (JSON.parse(cluster.specs[0]!) as { spec: { containers: Record<string, unknown>[] } }).spec.containers
    expect(containers[0]!.resources).toBeUndefined()
  }, 30000)

  it('加载期就拒绝不是 quantity 的内存上限', () => {
    // schema 只要求它是一个字符串（`z.string()`），所以这道检查在构造函数里，
    // 否则写错的取值要等到创建 Pod 才被 apiserver 拒绝，且报错指向拼出来的 spec。
    expect(() => harness({ memoryLimit: '2g' })).toThrow(/memoryLimit/)
  })
})
