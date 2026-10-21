/**
 * Kubernetes 容器运行时 provider：每个 (租户, 用户) 一个裸沙箱 Pod，通过 Pod 自己的 IP
 * 用 HTTP 访问。命令不走 `kubectl exec`；Pod 里跑的是与 Docker provider 相同的
 * tool-exec 服务，因此沙箱镜像与线上协议始终是同一份约定。
 *
 * 本 provider 与 `container-docker` 是 `ctx.containerRuntime` 上的两个实现，沙箱内的事实逐条对齐：
 * 同一张挂载表（`/workspace`、`/case`、`<workspaceRoot>/skills`、`/global`、
 * `systemRoot` 同路径、`/tools`、`pythonRoot` 同路径）、同一套 Python 三件套
 * （`PATH` 前置、`VIRTUAL_ENV`、`PYTHONPATH`）、同一组身份变量
 * （`DSH_CASE_ID`/`DSH_TENANT_ID`/`DSH_USER_ID`/`DSH_TOOL_EXEC_IDLE_MS`/`DSH_TOOL_EXEC_MAX_OUTPUT_BYTES`）、
 * 同一条 `/tools` 来源规则（租户记录优先，缺省回落配置），以及同名同义的 `idleTimeoutMs`、
 * `maxOutputBytes`、`sandboxCacheTtlMs`、`cliTimeoutMs`、`startTimeoutMs`、`transportTimeoutMs`。
 *
 * 两边只在「事实从哪里来」上不同：容器在宿主上，Pod 在集群里。凡是对不齐的地方，
 * 下面的 JSDoc 都会写明理由。
 * @module @deepseek-ai/dsh-container-k8s
 */

import { posix } from 'node:path'
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
import { SANDBOX_CASE_MOUNT, SANDBOX_SESSIONS_MOUNT, SANDBOX_WORKDIR_ENV, SANDBOX_WORKSPACE_MOUNT, TENANT_SESSIONS_DIR_NAME, TENANT_SKILL_DIR_NAME, TENANT_USERS_DIR_NAME, TENANT_WORK_DIR_NAME, requireTenant, requireUser, sandboxSessionDir } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { cliRunner, execToolCommand, openContainerPty, ptyRunner } from '@deepseek-ai/dsh-container-transport'
import type {
  ContainerCliRunner,
  ContainerPtyRunner,
  ContainerSessionExec,
  ToolExecClient,
  ToolExecRequest,
} from '@deepseek-ai/dsh-container-transport'
import {
  assertQuantity,
  buildSandboxPod,
  MANAGED_LABEL,
  sandboxPodName,
  sandboxResources,
  TOOL_EXEC_IDLE_ENV,
  TOOL_EXEC_MAX_OUTPUT_ENV,
} from './pod-spec.ts'
import type { SandboxMount } from './pod-spec.ts'

/**
 * Kubernetes 自带、在任何集群上都属于集群自己的命名空间。
 *
 * 这四个名字的对错只看配置就能判定，不需要读集群，所以它们的检查留在代码里。
 *
 * 依赖某个具体集群的名字——某个业务命名空间、某个存储组件的命名空间——一律不进这个包：
 * 那是部署事实，写死在包里等于把一台集群的拓扑发给所有集群。这类隔离由集群侧承担，
 * host 的 ServiceAccount 只有目标命名空间里的 Role，命名空间配错时创建请求会被
 * apiserver 拒绝。
 */
const CLUSTER_NAMESPACES = ['default', 'kube-system', 'kube-public', 'kube-node-lease'] as const

/** 期限码：本 provider 给自家的到期时刻打上它们，好把「自己超时」与「调用方取消」分开。 */
const CLI_TIMEOUT = 'CONTAINER_CLI_TIMEOUT'
const START_TIMEOUT = 'CONTAINER_START_TIMEOUT'
const READY_TIMEOUT = 'CONTAINER_READY_TIMEOUT'
const TRANSPORT_TIMEOUT = 'CONTAINER_TRANSPORT_TIMEOUT'

/** {@link Config.toolExecImagePath} 的默认值：随包镜像的 Debian 基础 PATH。 */
const DEFAULT_TOOL_EXEC_IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** {@link Config.cliTimeoutMs} 的默认值：与 `container-docker` 的同名字段同值。 */
const DEFAULT_CLI_TIMEOUT_MS = 60_000
/**
 * {@link Config.workDir} 的默认值：容器本地的一个空目录。
 *
 * 用 `/tmp/work` 而不是 `/tmp`，是为了让模型按相对路径写出的中间产物与 tool-exec 自己的临时文件
 * 分开。宿主的 `sandbox.workDir` 不配时也是这个值。
 */
const DEFAULT_WORK_DIR = '/tmp/work'
/**
 * {@link Config.caseReadOnly} 与 {@link Config.usersReadOnly} 的默认值：都只读。
 *
 * 这两棵目录树由业务侧写入，沙箱只是读取方；可写就会让一个用户的沙箱改到同案件其他用户的输入，
 * 也会让它们下面那两层只读的技能挂载失去意义。
 */
const DEFAULT_DATA_READ_ONLY = true
/**
 * 沙箱内 matplotlib 的缓存目录：`/tmp` 是 Pod 自己挂的 emptyDir，也是根只读之后容器里唯一
 * 保证可写的位置。
 *
 * `HOME` 是 `/root`，而根文件系统只读（见 `pod-spec.ts` 的 `readOnlyRootFilesystem`），
 * 所以按默认位置写缓存的库每次都拿到 EROFS：matplotlib 会打印一段警告再退回一个临时目录，
 * 并把这段话掺进每一条用到它的命令输出。缓存是可重建的东西，跟着沙箱一起消失正合适。
 */
const SANDBOX_MPLCONFIG_DIR = '/tmp/matplotlib'
/** {@link Config.startTimeoutMs} 的默认值：与 `container-docker` 的同名字段同值。 */
const DEFAULT_START_TIMEOUT_MS = 180_000
/** {@link Config.statusPollMs} 的默认值。 */
const DEFAULT_STATUS_POLL_MS = 500
/** {@link Config.readyTimeoutMs} 的默认值。 */
const DEFAULT_READY_TIMEOUT_MS = 10_000
/** {@link Config.readyPollMs} 的默认值。 */
const DEFAULT_READY_POLL_MS = 30
/** {@link Config.transportTimeoutMs} 的默认值。 */
const DEFAULT_TRANSPORT_TIMEOUT_MS = 600_000
/** {@link Config.sandboxCacheTtlMs} 的默认值。 */
const DEFAULT_SANDBOX_CACHE_TTL_MS = 5_000
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

/** 沙箱内 Python 三件套的显式取值；每项各自独立，与 `container-docker` 按标记逐个设置的规则一致。 */
export interface PythonSandboxEnv {
  /** 前置到 `PATH` 的目录，通常是 `<pythonRoot>/bin`。省略则不前置，`PATH` 保持镜像自己的值。 */
  binDir?: string
  /** `VIRTUAL_ENV` 的取值，通常是 `pythonRoot` 自身（该目录带 `pyvenv.cfg` 时）。省略则不设。 */
  virtualEnv?: string
  /** `PYTHONPATH` 的取值，通常是 `<pythonRoot>/lib/python3.<minor>/site-packages`，多个目录用 `:` 连接。省略则不设。 */
  sitePackages?: string
}

/** Kubernetes 沙箱 provider 的配置。 */
export interface Config {
  /**
   * 沙箱 Pod 所在的命名空间。本 provider 只在这一个命名空间里创建、读取和删除沙箱 Pod，
   * 每一条 kubectl 调用都带着它，除此之外不碰集群里的任何对象。
   * 没有默认值：默认值就等于把某一台集群的事实写进包里。
   */
  namespace?: string
  /** 沙箱容器镜像引用；必须已经存在于节点上。 */
  image?: string
  /** `kubectl` 可执行文件名或绝对路径。 */
  kubectlBinary?: string
  /** 沙箱容器的镜像拉取策略。 */
  imagePullPolicy?: string
  /**
   * 沙箱内 tool-exec 服务监听的容器端口。provider 把它同时用在两处：写进 Pod 的
   * `containerPort`，并作为镜像 entrypoint 的第一个位置参数传给沙箱进程，
   * 因此改这个值真的会改沙箱内的监听端口。与 `container-docker` 的同名字段同义。
   */
  toolExecPort?: number
  /**
   * 执行容器的工作目录。provider 在沙箱里把它挂成一个 `emptyDir`：容器根文件系统是只读的，
   * 不是挂载点就不存在，而它又必须存在——会话按相对路径解析出的位置就是这里。
   *
   * 它不能是任何 claim 上的挂载点：模型按相对路径写出的中间产物应当随沙箱销毁而消失，
   * 不落进用户案件的工作目录。宿主的 `sandbox.workDir` 必须是同一个值。
   */
  workDir?: string
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
   * 与 {@link claimRoot} 对应的 PersistentVolumeClaim。两者都设置时，每个挂载都通过
   * `subPath` 投影到这个 claim 上，沙箱不再带任何 `hostPath`，可以在任意节点启动。
   * 不设置则每一层都从节点目录提供，这要求运行沙箱的节点上确实存在这些目录。
   * 两者必须同时设置或同时省略：只写一个，本 provider 会在加载时报错，而不是悄悄退回 hostPath 模式。
   */
  workspaceClaim?: string
  /**
   * claim 在宿主机上的挂载点，同时也是每个 `source` 换算成 `subPath` 的根。
   * host 进程把同一个 claim 挂在这里，因此同一路径在两侧含义一致，
   * 两种模式之间切换时也不需要改任何已配置的根。
   */
  claimRoot?: string
  /** 宿主机上按 subject 分目录的根，挂到 `/global`。不设置则跳过该挂载。 */
  usersRoot?: string
  /** 存放全局 skill 树的宿主机目录，以只读方式挂到同一路径。 */
  systemRoot?: string
  /**
   * `/tools` 挂载的来源，供租户记录里没有 `toolsRoot` 的租户使用。来源规则是租户记录优先：
   * `tenant.toolsRoot` 存在时用它，缺省才回落到这里。省略本字段则这类租户的沙箱没有
   * `/tools` 挂载。（`container-docker` 的同名字段逐字同义。）
   */
  toolsRoot?: string
  /**
   * 存放 Python 运行时的宿主机目录，以只读方式挂到同一路径。tool-exec 镜像自身不带解释器，
   * 所以这份挂载就是沙箱唯一的 Python。省略则不挂载，也不设任何 Python 变量，
   * 沙箱里根本没有 `python3`——与 `container-docker` 省略同名 `pythonRoot` 完全一致。
   */
  pythonRoot?: string
  /**
   * 沙箱内 Python 三件套的取值，与 `container-docker` 的变量语义相同（`PATH` 前置、
   * `VIRTUAL_ENV`、`PYTHONPATH`），差别只在取值从哪来：docker 在宿主进程里读 `pythonRoot`
   * 的目录布局（同一个文件系统），而 k8s 的 `pythonRoot` 是节点上的目录（hostPath 模式）
   * 或 claim 里的子路径，宿主进程通常看不到它，也没有任何东西能替它读——所以这三个值
   * 必须由部署声明。每个字段各自独立：只给 `binDir` 的目录就只前置 `PATH`，
   * 与 docker 那边「只有 `bin` 就只设 `PATH`」是同一条规则。
   * 设置本字段时必须同时设置 {@link pythonRoot}：三个值描述的都是被挂载的那份运行时，
   * 没有挂载就无处可指。省略本字段时校验结果里不会留下空对象，`undefined` 就是「没配 Python」。
   */
  pythonEnv?: PythonSandboxEnv
  /**
   * `PATH` 的沙箱镜像取值，用于 `pythonEnv.binDir` 把挂载目录前置时重述镜像其余部分的 `PATH`
   * （Pod 的 `env` 是整体替换容器环境，不是追加）。默认取随包镜像的 Debian 基础值
   * （`node:22-bookworm-slim`；`docker/Dockerfile` 自己没设 PATH），与 `container-docker`
   * 的同名字段默认值相同。镜像的 PATH 不同时要一并设置，否则那个镜像追加的目录在沙箱里不再解析。
   */
  toolExecImagePath?: string
  /**
   * 每个沙箱里启动的容器命令，默认 `['node', 'entry.mjs']`——与随包镜像的
   * `ENTRYPOINT` 一致。provider 会把 {@link toolExecPort} 追加成它的下一个位置参数，
   * 因为镜像 entrypoint 的契约是 `entry.mjs <port> [host]`：Pod 写了 `command` 就不再使用
   * 镜像的 `CMD`，端口只能由 provider 显式给出。镜像的 entrypoint 契约不同时，把完整命令写在这里。
   */
  command?: string[]
  /**
   * 沙箱容器的显式环境变量。身份变量（`DSH_CASE_ID`、`DSH_TENANT_ID`、`DSH_USER_ID`）
   * 与 Python 三件套由本 provider 在它之后写入，因此部署改不了这几项：一个沙箱属于哪个案子
   * 与哪个人，只有平台知道，不能由被注入者自己声明。
   */
  env?: Record<string, string>
  /**
   * 单次 `kubectl` 调用的时间上限，单位毫秒。kubectl 会一直阻塞到 apiserver 作答，
   * 只有期限能终止它。默认 60000，与 `container-docker` 的同名字段同义且同默认值：
   * 同名字段的默认值必须一致，否则同一个部署换后端就换了超时行为。
   */
  cliTimeoutMs?: number
  /**
   * 一次冷启动的总时间上限，单位毫秒：它的 kubectl 调用（建 Pod、读状态）与等待就绪一起算在内。
   * 超过就让这次启动失败，并清掉该主体缓存的句柄与正在进行的启动记录，下一次 exec 重新冷启动，
   * 而不是复用一个永不 settle 的 promise。默认 180000，与 `container-docker` 的同名字段
   * 同义且同默认值；集群侧还要算上调度与拉镜像，所以这个上界不能按单次调用来估。
   */
  startTimeoutMs?: number
  /**
   * 等待 Pod 就绪期间读取集群状态的轮询间隔，单位毫秒。取值要权衡的是「多久发现沙箱起来了」
   * 与「每次读都要花掉一个 kubectl 进程和一次 apiserver 往返」。默认 500。
   */
  statusPollMs?: number
  /**
   * Pod 报告就绪之后，再等它内部 tool-exec 服务答得上话的时间上限，单位毫秒。
   * Pod 的 Ready 只说明容器进程起来了，而 tool-exec 服务何时开始监听端口是镜像 entrypoint
   * 自己的事，这段空档里第一条命令会撞上连接被拒。默认 10000，与 `container-docker`
   * 的同名字段同义。
   */
  readyTimeoutMs?: number
  /** 上面那次等待每次重试之间的间隔，单位毫秒。默认 30，与 `container-docker` 的同名字段同义。 */
  readyPollMs?: number
  /**
   * 一次 tool-exec HTTP 往返的时间上限，单位毫秒。它覆盖命令在沙箱内的执行，不只是连接，
   * 因此是这几个期限里最大的那个。默认 600000，与 `container-docker` 的同名字段同义。
   */
  transportTimeoutMs?: number
  /**
   * 一次解析出的沙箱句柄在多少毫秒内可以直接复用，过后重新从集群读一次状态。
   * 每次工具调用都要解析沙箱，不缓存的解析会在命令真正执行前先花掉一个 `kubectl` 进程和一次
   * API server 往返；并发会话会把这份开销成倍放大。取值要短到能及时发现沙箱被替换：
   * 过期的句柄指向一个已经不再服务的 Pod IP。默认 5000，与 `container-docker` 的同名字段同义。
   */
  sandboxCacheTtlMs?: number
  /**
   * 空闲多久后让该主体的沙箱自己退出，单位毫秒：provider 把它作为 `DSH_TOOL_EXEC_IDLE_MS`
   * 注入沙箱，容器据此判定「没有在途请求、且距上一次请求已超过预算」后自行退出，Pod 因此进入
   * 终态，由下一次启动的收尸清掉。宿主不自己计时：它看不见别的副本对这个沙箱的使用，而每一个
   * 请求都要到达容器。正在执行的命令不算空闲。省略则沙箱永不自行退出。
   * 与 `container-docker` 的同名字段同义。
   */
  idleTimeoutMs?: number
  /**
   * 沙箱内每次 exec 里**每条输出流**最多保留多少字节：provider 把它作为
   * `DSH_TOOL_EXEC_MAX_OUTPUT_BYTES` 注入沙箱，容器超过上界后继续读完这条流（停止读会让子进程
   * 在写满管道时阻塞），只保留末尾一段，并在结果里把该流标成已截断（见 `container-docker`
   * 的 `src/tool-exec.ts`，两个后端跑的是同一份服务）。上界只需高于宿主自己的结果上界
   * （`ctx.subprocess` 的每条流预算），它的用处是保护沙箱自己：原始流是容器先攒满、宿主才轮得到
   * 加界的，所以一条大输出命令能撑死沙箱。调低它会连带截断那些本来整段读得回来的大结果
   * （整份文件读取、`run_code` 自己 64 MiB 的载荷上界），所以它要留在部署里那些上界之上。
   * 与 `container-docker` 的同名字段逐字同义。默认 67108864。
   */
  maxOutputBytes?: number
  /**
   * 沙箱容器的内存上限，按 Kubernetes quantity 写法（如 `8Gi`）；省略则不限。
   *
   * 它管的是**命令自身**的内存，而不是被捕获的输出：`maxOutputBytes` 只约束 provider 留存的字节，
   * 一条在内存里排序大文件的命令照样能把容器撑到节点内存耗尽。不给上限的沙箱 Pod 落在 BestEffort，
   * 内核在内存耗尽时按 `oom_score_adj` 挑受害者，被挑中的可能是节点上任何与它无关的进程——
   * 沙箱里跑的是模型拼出来的命令，所以这里应当有界。
   */
  memoryLimit?: string
  /**
   * 沙箱容器的核数上限（整核数）；省略则不限。与 `container-docker` 的同名字段同义，
   * 只是写法换成 quantity：`2` 表示两核。
   */
  cpuLimit?: number
}

/** 运行中的沙箱 Pod 暴露给 host 的事实。 */
export interface SandboxStatus {
  /** Kubernetes 阶段；Pod 不存在时为 `Missing`。 */
  phase: string
  /** 沙箱运行起来后的 Pod IP。 */
  podIP?: string
  /** 是否所有容器都报告就绪。 */
  ready: boolean
  /** 创建 Pod 时记录下的 spec 指纹。 */
  fingerprint?: string
  /** 非运行状态的人可读说明（等待原因、init 失败、事件）。 */
  detail?: string
}

/** 查读一个已缓存沙箱句柄的过程与结果，供内部缓存使用。 */
interface CachedSandbox {
  /** 这次解析面对的 Pod 名；它由 (租户, 用户) 唯一决定，用于释放时点名删除。 */
  podName: string
  /** 观测到的沙箱状态。 */
  status: SandboxStatus
  /** 这个句柄可以直接用到什么时候，单位毫秒（`Date.now()` 刻度）。 */
  expiresAt: number
}

/**
 * 判断 `candidate` 是 `root` 本身还是它的后代。
 * @param root - 祖先路径。
 * @param candidate - 待判断的路径。
 * @returns candidate 没有逃出 root 时为 true。
 */
function isWithin(root: string, candidate: string): boolean {
  const rel = posix.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))
}

/**
 * 解析一个 (租户, 用户) 沙箱的挂载来源。
 *
 * `hostPath` 模式下 source 会被原样用作沙箱内的路径。这条「两者相等」的不变式是
 * hostPath 模式的立足点：路径一旦不一致，kubelet 会凭空造出一个空目录，
 * 而空挂载与「本来就是空的」工作区无法区分。
 *
 * 设置 {@link Config.workspaceClaim} 后，租户自己的数据改从一个 ReadWriteMany claim
 * 提供。此时不要求任何节点路径存在，同一个 (租户, 用户) 可以在任意节点启动，
 * 租户与用户的切分由 claim 内的子路径承担，原本由宿主目录结构承担。
 *
 * 变的只是来源：两种模式下每个 mountPath 都一样，因此沙箱及其读取方解析出的各层地址
 * ——包括位于 `<workspaceRoot>/skills` 的 skill 层——都保持不变。
 *
 * 三层技能另外各挂一份到聚合根 `/opt/data/skills` 下的 `<kind>` 子目录：案件脚本遍历那个根
 * 去发现技能，而一次挂载只能把一个来源放到一个位置，所以层与层之间只能靠子目录分开。
 *
 * 每个 source 都必须位于 {@link Config.claimRoot} 之下，且这个解析是全有或全无的：
 * claim 部署会把每一层都从 claim 挂载，global、system、tools、Python 层也不例外；
 * 落在 root 之外的 source 会在加载时报错，而不是产出一个逃出 claim 的 `subPath`。
 *
 * workspace root 属于租户，因此由租户记录传入而不是从 provider 配置读取：
 * 一个 provider 实例服务所有租户，而每个租户各自拥有一棵工作区树。`/tools` 的来源同样
 * 优先取租户记录、缺省回落 {@link Config.toolsRoot}，与 `container-docker` 逐字同义。
 *
 * 这张挂载表就是 `container-docker` 的那张：挂载点逐条相同，只有把挂载交给容器运行时的方式
 * 不同（这里是 Pod 的卷，那里是 `-v`），因此同一个部署切后端时不需要改任何已配置的根。
 * @param config - provider 配置。
 * @param tenant - 当前租户记录；`workspaceRoot` 决定工作区各层从哪里挂，`toolsRoot` 决定 `/tools`。
 * @param subject - 已认证的 subject。
 * @returns 挂载列表，顺序稳定。
 */
export function sandboxMounts(config: Config, tenant: Pick<Tenant, 'workspaceRoot' | 'toolsRoot'>, subject: string): SandboxMount[] {
  const workspaceRoot = tenant.workspaceRoot
  const skillsPath = `${workspaceRoot}/${TENANT_SKILL_DIR_NAME}`
  const userCase = `${workspaceRoot}/${TENANT_USERS_DIR_NAME}/${subject}`
  const SKILLS_ROOT = '/opt/data/skills'
  // 技能层同时挂进一个聚合根，案件脚本遍历它来发现技能。一次挂载只能把一个来源放到一个位置，
  // 所以层与层之间用子目录分开——同名技能可能同时存在于多层。层名与 `skill-tier` 注册的 kind 相同。
  const tier = (source: string, kind: string): { source: string; mountPath: string; readOnly: boolean } =>
    ({ source, mountPath: `${SKILLS_ROOT}/${kind}`, readOnly: true })
  const caseReadOnly = config.caseReadOnly ?? DEFAULT_DATA_READ_ONLY
  const usersReadOnly = config.usersReadOnly ?? DEFAULT_DATA_READ_ONLY
  const sources: Array<{ source: string; mountPath: string; readOnly: boolean }> = [
    { source: `${userCase}/${TENANT_WORK_DIR_NAME}`, mountPath: SANDBOX_WORKSPACE_MOUNT, readOnly: false },
    // 会话工作目录与用户案件工作目录平级：同层就会让挂载 `/workspace` 顺带交出这个人所有会话的目录树。
    { source: `${userCase}/${TENANT_SESSIONS_DIR_NAME}`, mountPath: SANDBOX_SESSIONS_MOUNT, readOnly: false },
    { source: `${workspaceRoot}/${TENANT_WORK_DIR_NAME}`, mountPath: SANDBOX_CASE_MOUNT, readOnly: caseReadOnly },
    { source: skillsPath, mountPath: skillsPath, readOnly: true },
    tier(skillsPath, 'case'),
  ]
  if (config.usersRoot) {
    sources.push({ source: `${config.usersRoot}/${subject}/${TENANT_WORK_DIR_NAME}`, mountPath: '/global', readOnly: usersReadOnly })
    sources.push(tier(`${config.usersRoot}/${subject}/${TENANT_SKILL_DIR_NAME}`, 'user-global'))
  }
  if (config.systemRoot) {
    sources.push({ source: config.systemRoot, mountPath: config.systemRoot, readOnly: true })
    sources.push(tier(`${config.systemRoot}/${TENANT_SKILL_DIR_NAME}`, 'system'))
  }
  const toolsRoot = tenant.toolsRoot ?? config.toolsRoot
  if (toolsRoot !== undefined) sources.push({ source: toolsRoot, mountPath: '/tools', readOnly: true })
  if (config.pythonRoot) sources.push({ source: config.pythonRoot, mountPath: config.pythonRoot, readOnly: true })

  const claim = config.workspaceClaim
  const claimRoot = config.claimRoot
  if (!claim || !claimRoot) return withLocalMountPoint(sources.map(m => ({ kind: 'hostPath', ...m })), SKILLS_ROOT)
  for (const m of sources) {
    if (!isWithin(claimRoot, m.source)) {
      throw new Error(
        `container-k8s: mount source '${m.source}' is outside claimRoot '${claimRoot}'. ` +
          'The claim mirrors that root, so every source must sit under it; widen claimRoot to a ' +
          'common ancestor of all configured roots.',
      )
    }
  }
  return withLocalMountPoint(
    sources.map(m => ({
      kind: 'claim',
      claimName: claim,
      subPath: posix.relative(claimRoot, m.source),
      mountPath: m.mountPath,
      readOnly: m.readOnly,
    })),
    SKILLS_ROOT,
  )
}

/**
 * 在第一个嵌在 `root` 之下的挂载前面插入一个容器本地可写空目录。
 *
 * 容器运行时先造出挂载目标再挂载，而目标落在另一个只读挂载里面时，那一步会被那个挂载的
 * `ro` 拒绝，Pod 因此永远进不了 `Running`。技能层的聚合根就是这种情况：它自己要挂在
 * `/case` 或 `/global` 里面，而那两层是只读的。租户层既然决定挂什么、挂到哪里，
 * 就要同时保证自己选的目标建得出来——把它交给镜像预先摆好同名目录，等于把这个约束
 * 押在一次构建上。
 * @param mounts - 已解析的挂载列表。
 * @param root - 需要成为可写父目录的容器内路径。
 * @returns 插入后的挂载列表；`root` 之下没有挂载时原样返回。
 */
export function withLocalMountPoint(mounts: SandboxMount[], root: string): SandboxMount[] {
  const first = mounts.findIndex(m => m.mountPath.startsWith(`${root}/`))
  if (first < 0) return mounts
  return [...mounts.slice(0, first), { kind: 'local', mountPath: root }, ...mounts.slice(first)]
}

/** 已认证的 tool-exec HTTP 客户端接缝；生产实现就是 `container-transport` 里的那个。 */
export type { ToolExecClient }

/**
 * 等待一个共享操作，`signal` 一 abort 就结束等待。
 *
 * 操作本身继续跑：promise 无法被打断，而一个 (租户, 用户) 的启动是与其他调用方共用的，
 * 所以这个 signal 只是让本次调用脱身，而不是取消别人的工作。同一个 signal 也会传到
 * 操作自己的取消路径上，因此被放弃的启动会很快 settle，不会留下 kubectl 子进程。
 *
 * 与 `container-docker` 里同名同义：两个 provider 的调用方脱离语义必须一致，
 * 而这段异步管道在两个包里都是同一份（jscpd 标记见下）。
 *
 * @param work - 要等待的操作。
 * @param signal - 结束这次等待的期限或取消。
 * @returns 操作的值；`signal` 先 abort 时抛出携带它 reason 的异常。
 */
/* jscpd:ignore-start -- deliberate mirror of container-docker's raceAbort: the two providers
   must detach callers from a shared start identically, and a shared home for it would put
   provider lifecycle plumbing into the transport seam. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason
      // 取消者没有义务给出 Error：非 Error 的 reason 只能字符串化后包一层，
      // 否则调用方拿到的是一个既读不出也说不出用途的东西。
      reject(reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? `container-k8s: the call was aborted: ${reason}` : 'container-k8s: the call was aborted'))
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
/* jscpd:ignore-end */

/**
 * Kubernetes 容器运行时（`ctx.containerRuntime`）。
 *
 * 每个 (租户, 用户) 一个裸 Pod。裸 Pod 没有控制器，因此不会有东西背着 host 把它重建；
 * host 会收养一个已存在、且记录的指纹仍与当前配置一致的 Pod，否则替换掉它。
 * 有了收养，重启 host 才便宜：否则每次重启都会丢掉所有已经热的沙箱。
 */
export class K8sContainerRuntime extends ContainerRuntime {
  /**
   * 插件 schema。必须挂在类上：Cordis 只从 `plugin.Config` 读它（`vendor/cordis/src/registry.ts`），
   * 对默认导出的类插件来说那就是这个静态成员。写成模块级的 `export const Config` 时，
   * 配置目录生成器认得它、运行时不认，默认值与 `z.natural().min(1)` 这类校验会静默失效。
   */
  static Config: z<Config> = z.object({
    namespace: z.string().description('Namespace the sandbox Pods are created in.'),
    image: z.string().description('Sandbox container image reference.'),
    kubectlBinary: z.string().default('kubectl'),
    imagePullPolicy: z.string().default('IfNotPresent'),
    toolExecPort: z.natural().min(1).default(8642),
    workDir: z.string().default(DEFAULT_WORK_DIR),
    caseReadOnly: z.boolean().default(true),
    usersReadOnly: z.boolean().default(true),
    workspaceClaim: z.string(),
    claimRoot: z.string(),
    usersRoot: z.string(),
    systemRoot: z.string(),
    toolsRoot: z.string(),
    pythonRoot: z.string(),
    // 阻止 Schemastery 把省略掉的 pythonEnv 变成 `{}`（与 `tool-subagent` 的 agentOptions
    // 同一个理由与同一种写法）：空对象会让「给了 pythonEnv 就必须给 pythonRoot」这条检查
    // 对每个没配 Python 的部署都成立。`.default(undefined)` 在运行时就是「不补默认值」。
    pythonEnv: z.object({
      binDir: z.string(),
      virtualEnv: z.string(),
      sitePackages: z.string(),
    }).default(undefined as unknown as Required<PythonSandboxEnv>),
    toolExecImagePath: z.string().default(DEFAULT_TOOL_EXEC_IMAGE_PATH),
    command: z.array(z.string()).default(['node', 'entry.mjs']),
    env: z.dict(z.string()).default({}),
    cliTimeoutMs: z.natural().min(1).default(DEFAULT_CLI_TIMEOUT_MS),
    startTimeoutMs: z.natural().min(1).default(DEFAULT_START_TIMEOUT_MS),
    statusPollMs: z.natural().min(1).default(DEFAULT_STATUS_POLL_MS),
    readyTimeoutMs: z.natural().min(1).default(DEFAULT_READY_TIMEOUT_MS),
    readyPollMs: z.natural().min(1).default(DEFAULT_READY_POLL_MS),
    transportTimeoutMs: z.natural().min(1).default(DEFAULT_TRANSPORT_TIMEOUT_MS),
    sandboxCacheTtlMs: z.natural().min(1).default(DEFAULT_SANDBOX_CACHE_TTL_MS),
    idleTimeoutMs: z.natural().min(1),
    maxOutputBytes: z.natural().min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
    memoryLimit: z.string(),
    cpuLimit: z.natural().min(1),
  })

  private readonly config: Config
  private readonly runner: ContainerCliRunner
  private readonly pty: ContainerPtyRunner
  private readonly client: ToolExecClient
  private readonly namespace: string
  private readonly image: string
  private readonly imagePullPolicy: string
  private readonly toolExecPort: number
  private readonly workDir: string
  private readonly toolExecImagePath: string
  private readonly command: readonly string[]
  private readonly cliTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly statusPollMs: number
  private readonly readyTimeoutMs: number
  private readonly readyPollMs: number
  private readonly transportTimeoutMs: number
  private readonly sandboxCacheTtlMs: number
  private readonly idleTimeoutMs: number | undefined
  private readonly maxOutputBytes: number
  private readonly memoryLimit: string | undefined
  private readonly cpuLimit: number | undefined
  /** 已解析的沙箱句柄，按 (租户, subject) 索引，在 `expiresAt` 之前有效。 */
  private readonly sandboxes = new Map<string, CachedSandbox>()
  /** 已经建好会话工作目录的 (租户, subject, 会话)；目录在 PVC 上，建过一次就够了。 */
  private readonly sessionDirs = new Set<string>()
  /** 正在进行的启动，让并发调用方共用一次而不是互相抢。 */
  private readonly starting = new Map<string, Promise<SandboxStatus>>()

  /**
   * @param ctx - 本 provider 注册其 effect 的 Cordis 上下文。
   * @param config - 已校验的插件配置。
   * @param runner - kubectl 调用的接缝；生产环境真的去拉起配置的那个二进制。
   * @param client - tool-exec HTTP 接缝；生产环境直接 `fetch` Pod 地址。
   * @param pty - 交互终端的接缝；生产环境把 kubectl 放进本地 PTY 里跑。
   */
  constructor(
    ctx: Context,
    config: Config,
    runner?: ContainerCliRunner,
    client?: ToolExecClient,
    pty?: ContainerPtyRunner,
  ) {
    super(ctx)
    const namespace = config.namespace
    if (!namespace) throw new Error('container-k8s: Config.namespace is required')
    if ((CLUSTER_NAMESPACES as readonly string[]).includes(namespace)) {
      throw new Error(`container-k8s: namespace '${namespace}' belongs to the cluster itself; sandbox Pods must be created in a namespace this deployment owns`)
    }
    if (!config.image) throw new Error('container-k8s: Config.image is required')
    // claim 模式是全有或全无的：只写一个字段就退回 hostPath，会把「本该任意节点可跑」的部署
    // 悄悄钉在节点目录上，而这件事只在沙箱起不来时才被发现。
    if ((config.workspaceClaim === undefined) !== (config.claimRoot === undefined)) {
      throw new Error('container-k8s: Config.workspaceClaim and Config.claimRoot must be set together or omitted together')
    }
    // 三个值描述的是被挂载的那份运行时：没有 pythonRoot 就没有挂载，写了也无处可指。
    if (config.pythonEnv !== undefined && config.pythonRoot === undefined) {
      throw new Error('container-k8s: Config.pythonEnv requires Config.pythonRoot: it describes the layout of the runtime mounted there')
    }
    // 内存上限写错时，apiserver 要到创建 Pod 才拒绝，且报错指向拼出来的 spec 而不是这一项；
    // 这个写法只看配置就能判定。
    if (config.memoryLimit !== undefined) assertQuantity('Config.memoryLimit', config.memoryLimit)
    this.config = config
    this.namespace = namespace
    this.image = config.image
    this.imagePullPolicy = config.imagePullPolicy ?? 'IfNotPresent'
    this.toolExecPort = config.toolExecPort ?? 8642
    this.workDir = config.workDir ?? DEFAULT_WORK_DIR
    this.toolExecImagePath = config.toolExecImagePath ?? DEFAULT_TOOL_EXEC_IMAGE_PATH
    this.command = config.command ?? ['node', 'entry.mjs']
    this.cliTimeoutMs = config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
    this.startTimeoutMs = config.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.statusPollMs = config.statusPollMs ?? DEFAULT_STATUS_POLL_MS
    this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.readyPollMs = config.readyPollMs ?? DEFAULT_READY_POLL_MS
    this.transportTimeoutMs = config.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS
    this.sandboxCacheTtlMs = config.sandboxCacheTtlMs ?? DEFAULT_SANDBOX_CACHE_TTL_MS
    this.idleTimeoutMs = config.idleTimeoutMs
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.memoryLimit = config.memoryLimit
    this.cpuLimit = config.cpuLimit
    this.runner = runner ?? cliRunner(config.kubectlBinary ?? 'kubectl')
    this.pty = pty ?? ptyRunner(config.kubectlBinary ?? 'kubectl')
    this.client = client ?? { exec: execToolCommand }
    ctx.effect(() => {
      // 启动时收一次尸：沙箱自己的空闲 watchdog 退出后留下的终态 Pod，以及宿主非优雅退出时
      // 没来得及清理的那些，都不再属于任何人。只碰终态 Pod——Running/Pending 的可能是另一个
      // 副本正在用的沙箱，删它就是两个实例互相替换对方的工作。
      void this.reapTerminalSandboxes().catch(() => {
        // 收尸是尽力而为的清洁：失败与成功没有区别，下一次启动还会再收一次，
        // 而这里没有别的行为依赖它的结果。
      })
      return () => {
        // 只清本进程的句柄，不删 Pod：裸 Pod 是所有服务同一 (租户, 用户) 的 host 实例共用的
        // 资源，一个实例退出就删掉它，等于拆掉另一个实例正在做的事。空闲回收由沙箱自己按
        // `idleTimeoutMs` 执行，终态的残骸由下一次启动的收尸清掉。
        this.sandboxes.clear()
      }
    }, 'container-k8s teardown')
  }

  /**
   * 在当前租户的沙箱里执行一条命令并捕获它的输出流。
   * @param command - 沙箱内的可执行文件。
   * @param args - 位置参数（这里从不做 shell 解释）。
   * @param opts - 可选的 stdin 输入、工作目录、环境变量与取消信号。
   * @returns 命令的退出码与捕获到的 stdout/stderr。
   * @throws 不在已认证请求上下文里时抛 `TenantError`，错误码 `NO_TENANT_IN_SCOPE`。
   */
  async exec(command: string, args: readonly string[], opts?: ContainerExecOptions): Promise<ContainerCommandResult> {
    const tenant = requireTenant()
    const subject = String(requireUser())
    const key = this.scopeKey(tenant.id, subject)
    /* jscpd:ignore-start -- 这一段与 container-docker/src/index.ts 的对应段落是同一套语义：
       两个 provider 都必须让调用方的取消只脱离本次调用，并把取消与这一轮传输期限融在一起。
       抽到共享位置会把 provider 生命周期塞进传输接缝，而那里只该有 CLI 与 HTTP 两个接缝。 */
    const req: ToolExecRequest = { argv: [command, ...args] }
    if (opts?.cwd !== undefined) req.cwd = opts.cwd
    if (opts?.env !== undefined) req.env = { ...opts.env }
    if (opts?.stdin !== undefined) req.stdin = opts.stdin
    // 会话工作目录盖过调用方给的工作目录：调用方手上的是它自己那台机器上的路径，
    // 而沙箱里的路径由挂载表决定。不带会话的 exec（探针、宿主自己的工具调用）保持原样。
    const sessionDir = sandboxSessionDir(opts?.env)
    if (sessionDir !== undefined) {
      req.cwd = sessionDir
      req.env = { ...(req.env ?? {}), [SANDBOX_WORKDIR_ENV]: sessionDir }
    }
    const status = await this.awaitSandbox(tenant, subject, opts?.signal)
    // 调用方的取消与这一轮自己的期限融在一起：tool-exec 服务可能不再作答，
    // 而没有期限的请求永远不会 settle。
    using transport = deadline(opts?.signal, this.transportTimeoutMs, TRANSPORT_TIMEOUT)
    /* jscpd:ignore-end */
    try {
      // 会话目录落在挂载进来的案件成员工作区上，所以它可能已经存在（同一个人的另一个沙箱、
      // 或上一次启动建的），也可能还没建：`mkdir -p` 对两种情况都对，而每个会话只跑一次。
      if (sessionDir !== undefined) await this.ensureSessionDir(status, key, sessionDir, transport.signal)
      return await this.runIn(this.toolExecBaseUrl(status), req, transport.signal)
    } catch (error: unknown) {
      // 沙箱没有保证的寿命：Pod 可能被驱逐、被另一个实例的空闲回收删掉，host 可能重启。
      // 缓存的地址那时就是死的，而之后每一次调用都会以同一种方式失败。
      // `client.exec` 只在传输或协议失败时 reject —— 命令自己的退出码是随结果回来的 ——
      // 所以一次 reject 意味着这个沙箱可能已经不在了：丢掉它并对新沙箱重跑同一条请求，
      // 而不是把一个「沙箱不可达」的错误抛给主体。
      if (opts?.signal?.aborted === true) throw error
      this.discard(key)
      if (timeoutOf(transport.signal, TRANSPORT_TIMEOUT) !== undefined) {
        // 到期不是传输失败：命令可能还在沙箱里跑，在这里重跑它会重复它的副作用。
        // 上面那次丢弃仍然让下一次调用落在一个新沙箱上。
        throw new Error(
          `container-k8s: the tool-exec server of tenant '${String(tenant.id)}' member '${subject}' did not answer within ${this.transportTimeoutMs}ms`,
        )
      }
      const fresh = await this.ensureSandbox(tenant, subject)
      return await this.runIn(this.toolExecBaseUrl(fresh), req, transport.signal)
    }
  }

  /**
   * 在当前租户的沙箱里开一个真正的交互终端。
   *
   * 走 `kubectl exec -i -t`：kubelet 因此让容器运行时给这条 exec 分配一个真正的
   * PTY，沙箱内的 `isatty` 为真、行编辑与交互式程序可用——这正是 tool-exec 的一次性
   * `POST /exec` 给不了的东西。kubectl 自己也需要一个终端（`-i -t` 在 stdin 是管道时
   * 的行为不可依赖），所以它跑在宿主分配出来的 PTY 里。
   *
   * 沙箱在开会话时就被钉住：会话发布之后调用方可能已经不在原来的请求上下文里，
   * 那时再按环境解析 (租户, 用户) 会落到别人的沙箱上。探针因此打在这一次捕获的地址上。
   *
   * @param options - 沙箱内的命令行、终端尺寸、保留输出上界与取消信号。
   * @returns 活着的交互会话。
   * @throws 不在已认证请求上下文里时抛 `TenantError`，错误码 `NO_TENANT_IN_SCOPE`；
   * 沙箱起不来、命令行没能在期限内接管终端时抛对应错误。
   */
  async openPty(options: ContainerPtyOptions): Promise<ContainerPtySession> {
    const tenant = requireTenant()
    const subject = String(requireUser())
    const status = await this.awaitSandbox(tenant, subject, options.signal)
    const baseUrl = this.toolExecBaseUrl(status)
    const exec: ContainerSessionExec = async (command, args, signal) => {
      // 探针同样是一次往返，所以和 `exec` 用同一条传输期限：沙箱不再作答时它必须失败，
      // 而不是把会话之后每一次探测都挂住。
      using transport = deadline(signal, this.transportTimeoutMs, TRANSPORT_TIMEOUT)
      return await this.runIn(baseUrl, { argv: [command, ...args] }, transport.signal)
    }
    const podName = sandboxPodName(String(tenant.id), subject)
    return await openContainerPty({
      argv: [
        '-n', this.namespace, 'exec', '-i', '-t', podName, '--',
        options.command, ...options.args ?? [],
      ],
      options,
      runner: this.pty,
      exec,
      roundTripTimeoutMs: this.transportTimeoutMs,
    })
  }

  /**
   * 采纳或新建的沙箱都要过这一关：就绪，且它的 tool-exec 服务答得上话。过不了就删掉它。
   *
   * 一个在自己的启动期限里没就绪、或就绪了却答不上话的沙箱，对任何实例都不可用：`ensureSandbox`
   * 只收养 Running/Pending，而收养之后同样要过这一关，所以留着它只会永久占住这个 (租户, 用户)——
   * 每一次重试都重新收养同一个坏掉的 Pod，而裸 Pod 没有控制器，谁也不会把它收走。
   * @param podName - 沙箱 Pod 名。
   * @param signal - 这次启动的期限。
   * @returns 就绪且服务可用的沙箱状态。
   * @throws 这个沙箱没能在期限内可用时；抛出前已经尝试删掉它。
   */
  private async confirmOrRelease(podName: string, signal: AbortSignal): Promise<SandboxStatus> {
    try {
      return await this.confirmSandbox(podName, signal)
    } catch (error: unknown) {
      await this.releasePod(podName).catch(() => {
        // 删不掉就留着：下一次使用还会收养它并在这里再到一次，抛出的仍是这一次的失败。
      })
      throw error
    }
  }

  /**
   * 一并 POST 一条命令并把结果收成容器运行时的返回类型。
   * @param baseUrl - 沙箱 tool-exec 服务的地址。
   * @param req - 参数向量与可选的 cwd/env/stdin。
   * @param signal - 这次往返的期限与取消。
   * @returns 命令的退出码与捕获到的 stdout/stderr。
   */
  private async runIn(baseUrl: string, req: ToolExecRequest, signal: AbortSignal): Promise<ContainerCommandResult> {
    const result = await this.client.exec(baseUrl, req, signal)
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      // 容器侧上界截断了某条流时把这件事带给调用方：只看到末尾一段的调用方不能把它当成全部输出。
      ...result.stdoutTruncated === true ? { stdoutTruncated: true } : {},
      ...result.stderrTruncated === true ? { stderrTruncated: true } : {},
    }
  }

  /**
   * 等该主体的沙箱，并让调用方的取消只影响这次调用。
   *
   * `ensureSandbox` 的 promise 是与同一主体的其他调用方共用的，所以取消只是让本次调用脱身，
   * 而不是取消别人正在等的启动。
   *
   * @param tenant - 当前租户。
   * @param subject - 已认证的 subject。
   * @param signal - 调用方的取消信号，若有。
   * @returns 该主体活着的沙箱状态。
   * @throws `signal` 已经 abort，或先于沙箱就绪 abort 时，抛出它的 reason。
   */
  private async awaitSandbox(tenant: Tenant, subject: string, signal: AbortSignal | undefined): Promise<SandboxStatus> {
    // 已经取消的调用不该去启动一个没人要的 Pod。
    signal?.throwIfAborted()
    const start = this.ensureSandbox(tenant, subject)
    if (signal === undefined) return await start
    return await raceAbort(start, signal)
  }

  /**
   * 沙箱内 tool-exec 服务的地址。
   * @param status - 观测到的沙箱状态。
   * @returns 该沙箱 tool-exec 服务的基地址。
   * @throws 沙箱还没有 Pod IP 时。
   */
  /**
   * 建出一个会话的工作目录，每个 (租户, 用户, 会话) 只建一次。
   *
   * 目录在挂载进来的案件成员工作区上，所以它可能已经存在：沙箱会被替换，而目录不会。
   * `mkdir -p` 对两种情况都对，因此这里不需要先看一眼它是否存在。
   * @param status - 要建目录的那个沙箱。
   * @param key - (租户, subject) 作用域键。
   * @param sessionDir - 会话工作目录在沙箱内的绝对路径。
   * @param signal - 这一轮传输的期限。
   */
  private async ensureSessionDir(status: SandboxStatus, key: string, sessionDir: string, signal: AbortSignal): Promise<void> {
    const seen = `${key} ${sessionDir}`
    if (this.sessionDirs.has(seen)) return
    await this.client.exec(this.toolExecBaseUrl(status), { argv: ['mkdir', '-p', sessionDir] }, signal)
    this.sessionDirs.add(seen)
  }

  private toolExecBaseUrl(status: SandboxStatus): string {
    if (!status.podIP) {
      throw new Error(`container-k8s: sandbox ${status.phase} without a Pod IP${status.detail ? `: ${status.detail}` : ''}`)
    }
    return `http://${status.podIP}:${this.toolExecPort}`
  }

  /** 一个 (租户, subject) 在内存里的键。 */
  private scopeKey(tenantId: Tenant['id'], subject: string): string {
    return `${tenantId}\u0000${subject}`
  }

  /**
   * 返回某个 (租户, 用户) 的运行中沙箱，必要时创建或替换它。
   *
   * 返回的 promise 一定会 settle：`startTimeoutMs` 给启动上界，两条 settle 路径都清掉
   * `starting` 里那一项，失败的启动也已经在 `startWithinDeadline` 里丢掉句柄。
   *
   * @param tenant - 当前租户记录；它的 `workspaceRoot` 决定沙箱的挂载。
   * @param subject - 已认证的 subject。
   * @returns 观测到的沙箱状态。
   */
  private ensureSandbox(tenant: Tenant, subject: string): Promise<SandboxStatus> {
    const key = this.scopeKey(tenant.id, subject)
    const cached = this.sandboxes.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now() && cached.status.ready) return Promise.resolve(cached.status)
    const inFlight = this.starting.get(key)
    if (inFlight) return inFlight
    const podName = sandboxPodName(String(tenant.id), subject)
    const started = this.startWithinDeadline(key, tenant, subject, podName)
    this.starting.set(key, started)
    started.then(
      (status) => {
        this.sandboxes.set(key, { podName, status, expiresAt: Date.now() + this.sandboxCacheTtlMs })
        this.starting.delete(key)
      },
      () => {
        this.starting.delete(key)
      },
    )
    return started
  }

  /**
   * 在 `startTimeoutMs` 之内把一个沙箱启动（或收养）好，失败时不留下任何缓存。
   *
   * @param key - (租户, subject) 作用域键。
   * @param tenant - 当前租户记录。
   * @param subject - 已认证的 subject。
   * @param podName - 这个作用域的 Pod 名。
   * @returns 就绪、且 tool-exec 服务答得上话的沙箱状态。
   * @throws 超过 `startTimeoutMs` 时，或启动自身的失败。
   */
  private async startWithinDeadline(key: string, tenant: Tenant, subject: string, podName: string): Promise<SandboxStatus> {
    using d = deadline(undefined, this.startTimeoutMs, START_TIMEOUT)
    try {
      return await raceAbort(this.startSandbox(tenant, subject, d.signal), d.signal)
    } catch (error: unknown) {
      // 没跑完的启动不能给这个主体留下任何缓存：`starting` 里的那一项会把同一个永不 settle 的
      // promise 交给之后每一次 exec，而 `discard` 丢掉缓存的句柄、空闲计时器和那个 Pod。
      this.starting.delete(key)
      this.discard(key)
      const timeout = timeoutOf(d.signal, START_TIMEOUT)
      if (timeout === undefined) throw error
      // 超时那一刻 kubelet 报了哪条事件，是运维唯一能据以行动的线索（缺的节点目录就只出现在事件里），
      // 所以这里补读一次事件；它用自己的期限，因为启动期限此刻已经耗尽。
      const events = await this.readEvents(podName)
      throw new Error(
        `container-k8s: starting the sandbox of tenant '${String(tenant.id)}' member '${subject}' did not finish within ${timeout.timeoutMs}ms` +
          (events.length > 0 ? `; events: ${events.join(' | ')}` : ''),
      )
    }
  }

  /**
   * 从集群解析出一个沙箱，必要时创建或替换它，最后确认它真的在服务。
   * @param tenant - 当前租户记录。
   * @param subject - 已认证的 subject。
   * @param signal - 这次启动的期限，会传到每一条 kubectl 调用上。
   * @returns 就绪、且 tool-exec 服务答得上话的沙箱状态。
   */
  private async startSandbox(tenant: Tenant, subject: string, signal: AbortSignal): Promise<SandboxStatus> {
    const tenantId = String(tenant.id)
    const podName = sandboxPodName(tenantId, subject)
    const mounts = sandboxMounts(this.config, tenant, subject)
    const resources = sandboxResources(this.memoryLimit, this.cpuLimit)
    const { spec, fingerprint } = buildSandboxPod({
      namespace: this.namespace,
      image: this.image,
      imagePullPolicy: this.imagePullPolicy,
      podName,
      // 镜像 entrypoint 的契约是 `entry.mjs <port> [host]`（见 packages/tenant/container-docker/docker/entry.mjs）。
      // Pod 一旦写了 command 就不再使用镜像的 CMD，所以端口必须由这里显式传下去：
      // 不传，沙箱只会监听镜像 CMD 里的那个端口，而 provider 却按配置的 toolExecPort 去拨号。
      command: [...this.command, String(this.toolExecPort)],
      mounts,
      env: this.sandboxEnv(tenantId, subject),
      toolExecPort: this.toolExecPort,
      workDir: this.workDir,
      ...(resources !== undefined ? { resources } : {}),
    })
    spec.metadata.annotations['dsh.dev/spec-fingerprint'] = fingerprint
    spec.metadata.annotations['dsh.dev/tenant'] = tenantId
    spec.metadata.annotations['dsh.dev/subject'] = subject

    const existing = await this.readStatus(podName, signal)
    if (existing.phase !== 'Missing') {
      // 沙箱由所有服务同一 (租户, 用户) 的 host 实例共享，不属于碰巧启动它的那一个实例。
      // 两个实例若对 spec 的理解不一致，就会互相不停替换对方的沙箱，
      // 所以这种不一致属于部署故障：报出来，别动那个正在运行的沙箱。
      if (existing.fingerprint !== fingerprint) {
        throw new Error(
          `container-k8s: sandbox ${podName} runs a different spec than this host would create ` +
            `(recorded ${existing.fingerprint || '<none>'}, local ${fingerprint}). Instances serving one ` +
            'tenant must agree on image, command, mounts and environment; align them, or the ' +
            'recorded sandbox must be deleted before this host can serve the tenant.',
        )
      }
      // Running 和 Pending 都算活着：直接收养。收养另一个实例还在启动的沙箱，
      // 才不会把一个实例的工作删掉另一个实例的手上；若这个沙箱最终不可用，
      // 下面的就绪等待会大声失败。
      if (existing.phase === 'Running' || existing.phase === 'Pending') {
        // 收养另一个实例的沙箱时日志里留一行：宿主之后执行的每一条命令都落在它上面，
        // 而这条对应关系只存在于内存里（`sandboxes` 缓存），进程一换就查不到了。
        this.ctx.logger.info(
          'container-k8s: adopting sandbox %s for tenant %s subject %s (phase %s)',
          podName, tenantId, subject, existing.phase,
        )
        return await this.confirmOrRelease(podName, signal)
      }
      // 已经退出的沙箱不能复用；不等待直接替换，
      // 免得一个实例的启动被另一个实例的收尾拖住。
      // 一个沙箱的死因只出现在集群事件里（OOMKilled 是最常见的一种），而替换本身不报错，
      // 所以死因与阶段一起记下来：这是宿主日志里唯一能看出「上一个沙箱怎么没的」的地方。
      const events = await this.readEvents(podName)
      this.ctx.logger.warn(
        'container-k8s: replacing sandbox %s for tenant %s subject %s: it is in phase %s%s',
        podName, tenantId, subject, existing.phase,
        events.length > 0 ? `; events: ${events.join(' | ')}` : '',
      )
      await this.releasePod(podName, signal)
    }

    const created = await this.runKubectl(['create', '-f', '-'], JSON.stringify(spec), signal)
    // 两个实例可能同时通过上面的检查、同时发起创建。Kubernetes 会挑一个赢家；
    // 输的那个收养赢家创建出来的沙箱，而不是报一个调用方无能为力的失败。
    if (created.exitCode !== 0 && !/AlreadyExists/i.test(created.stderr)) {
      throw new Error(`container-k8s: could not create sandbox ${podName}: ${created.stderr.trim() || created.stdout.trim()}`)
    }
    // 沙箱是按需创建、又在别的组件里看不见的东西：留一行创建事实（含这一次生效的资源上界），
    // 事后查「它为什么被 OOM 杀掉」才有起点。输掉创建竞争的那个实例不是创建者，日志里也不该这么说。
    if (created.exitCode === 0) {
      this.ctx.logger.info(
        'container-k8s: created sandbox %s for tenant %s subject %s (image %s, %s)',
        podName, tenantId, subject, this.image,
        resources === undefined ? 'no resource limits' : `limits ${JSON.stringify(resources.limits)}`,
      )
    } else {
      this.ctx.logger.info(
        'container-k8s: lost the creation race for sandbox %s (tenant %s, subject %s); adopting the winner',
        podName, tenantId, subject,
      )
    }
    return await this.confirmOrRelease(podName, signal)
  }

  /**
   * 把一个沙箱确认到「可以执行命令」为止：先等 Pod 报告 Running 且 Ready，
   * 再等它内部的 tool-exec 服务答得上话。
   *
   * 第二步不是多余：Pod 的 Ready 只说明容器进程起来了，entrypoint 绑定端口是它自己的事，
   * 这段空档里第一条命令会撞上连接被拒。`container-docker` 的 `waitReady` 挡的是同一件事。
   * @param podName - 沙箱 Pod 名。
   * @param signal - 这次启动的期限。
   * @returns 就绪且服务可用的沙箱状态。
   * @throws Pod 进不了可运行状态时，或 tool-exec 服务在 `readyTimeoutMs` 内没作答时。
   */
  private async confirmSandbox(podName: string, signal: AbortSignal): Promise<SandboxStatus> {
    const status = await this.waitReady(podName, signal)
    if (!status.podIP) throw new Error(`container-k8s: sandbox ${podName} reports ready without a Pod IP`)
    const baseUrl = `http://${status.podIP}:${this.toolExecPort}`
    using d = deadline(signal, this.readyTimeoutMs, READY_TIMEOUT)
    let lastError: unknown
    while (!d.signal.aborted) {
      try {
        await this.client.exec(baseUrl, { argv: ['sh', '-c', 'true'] }, d.signal)
        return status
      } catch (error: unknown) {
        lastError = error
        await new Promise<void>(resolve => setTimeout(resolve, this.readyPollMs))
      }
    }
    // 先把期限耗尽的那个原因报出来，别把它记到就绪等待头上：一次到期只该有一个说法。
    if (timeoutOf(d.signal, READY_TIMEOUT) === undefined) {
      throw new Error(`container-k8s: starting sandbox '${podName}' stopped before its tool-exec server answered`)
    }
    throw new Error(`container-k8s: the tool-exec server of sandbox '${podName}' never answered: ${String(lastError)}`)
  }

  /**
   * 一个沙箱容器的环境变量：配置的显式变量、Python 三件套，以及平台自己知道的身份事实。
   *
   * 身份变量写在最后，因此部署配置里的同名项改不了它们：一个沙箱属于哪个案子与哪个人，
   * 只有平台知道，而不能由被注入者自己声明。
   * @param tenantId - 当前租户标识。
   * @param subject - 已认证的 subject。
   * @returns 交给 Pod spec 的环境变量。
   */
  private sandboxEnv(tenantId: string, subject: string): Record<string, string> {
    const env: Record<string, string> = { ...this.config.env }
    const python = this.config.pythonEnv
    // 每一项各自独立地跟着自己的字段走，与 container-docker 的「哪个标记在就设哪个变量」同一条规则。
    if (python?.binDir !== undefined) env.PATH = `${python.binDir}:${this.toolExecImagePath}`
    if (python?.virtualEnv !== undefined) env.VIRTUAL_ENV = python.virtualEnv
    if (python?.sitePackages !== undefined) env.PYTHONPATH = python.sitePackages
    // 默认的缓存位置在只读根上写不进去（见 SANDBOX_MPLCONFIG_DIR），这里补一个可写位置。
    // 它排在身份变量之前：缓存位置是部署可以改的，而身份是三件平台才知道的事实。
    if (env.MPLCONFIGDIR === undefined) env.MPLCONFIGDIR = SANDBOX_MPLCONFIG_DIR
    // 身份事实：沙箱里的命令（skill、挂载进来的工具）靠它们认领自己属于哪个案子与哪个人，
    // 而容器名、`/case` 目录名、Pod 名都是有损的把手，推不出这两件事。
    // 三个名字与 container-docker 注入的是同一组，两个后端给出的值也相同。
    env.DSH_CASE_ID = tenantId
    env.DSH_TENANT_ID = tenantId
    env.DSH_USER_ID = subject
    // 空闲预算交给沙箱自己执行：宿主看不见别的副本对它的使用，而每一个请求都要到达容器，
    // 所以「有没有人用」只有容器答得准。它排在这里的理由与身份变量相同：由平台给出。
    if (this.idleTimeoutMs !== undefined) env[TOOL_EXEC_IDLE_ENV] = String(this.idleTimeoutMs)
    // 输出上界同样由沙箱自己执行，理由比空闲更强：原始流是容器先攒满、宿主才轮得到加界的，
    // 上界不注入沙箱就等于没设——一条 `find /` 的输出能把沙箱撑死。它和空闲预算一样由平台给出，
    // 因此同样排在配置的环境变量之后。
    env[TOOL_EXEC_MAX_OUTPUT_ENV] = String(this.maxOutputBytes)
    return env
  }

  /**
   * 读取一个 Pod 的阶段、就绪状态、IP 与记录的指纹。
   * @param podName - 沙箱 Pod 名。
   * @param signal - 这次启动的期限。
   * @returns 观测到的状态；Pod 不存在时为 `Missing`。
   */
  private async readStatus(podName: string, signal?: AbortSignal): Promise<SandboxStatus> {
    const result = await this.runKubectl(['get', 'pod', podName, '-o', 'json'], undefined, signal)
    if (result.exitCode !== 0) {
      if (/NotFound/i.test(result.stderr)) return { phase: 'Missing', ready: false }
      throw new Error(`container-k8s: could not read sandbox ${podName}: ${result.stderr.trim()}`)
    }
    return parsePodStatus(result.stdout)
  }

  /**
   * 读取 Kubernetes 为一个沙箱记录的近期事件。
   *
   * `hostPath` 来源缺失的沙箱根本进不了 init 容器：kubelet 先一步拒掉这个卷，
   * 而这件事只体现在事件里，Pod 就停在 `Pending`。没有这些事件，这次失败在启动
   * 超时之前都只表现为「还在启动」，对运维来说完全看不出该去创建哪条路径。
   * @param podName - 沙箱 Pod 名。
   * @returns 每个事件一行，最近的排在最后。
   */
  private async readEvents(podName: string): Promise<string[]> {
    let result: ContainerCommandResult
    try {
      result = await this.runKubectl(['get', 'events', '--field-selector', `involvedObject.name=${podName}`, '-o', 'json'])
    } catch {
      // 事件只是给一次失败加一句说明，读不到它（kubectl 期限耗尽、apiserver 卡住）不能把真正的
      // 失败换成一个关于事件的错误：调用方手上已经有这次失败可以汇报了。
      return []
    }
    if (result.exitCode !== 0) return []
    try {
      const parsed = JSON.parse(result.stdout) as { items?: { reason?: string; message?: string; type?: string }[] }
      return (parsed.items ?? [])
        .filter(e => e.message)
        .map(e => `${e.type ?? 'Event'} ${e.reason ?? ''}: ${e.message}`.trim())
    } catch {
      // 事件列表解析失败同样只是少一句说明，理由同上面那个 catch。
      return []
    }
  }

  /**
   * 轮询到沙箱报告就绪为止。
   * @param podName - 沙箱 Pod 名。
   * @param signal - 这次启动的期限；到期就停止等待。
   * @returns 就绪状态。
   * @throws Pod 进入再也走不出来的阶段时，或启动期限已到。
   */
  private async waitReady(podName: string, signal: AbortSignal): Promise<SandboxStatus> {
    let last: SandboxStatus = { phase: 'Unknown', ready: false }
    while (!signal.aborted) {
      last = await this.readStatus(podName, signal)
      if (last.phase === 'Running' && last.ready && last.podIP) return last
      if (terminalPhases.has(last.phase)) break
      await new Promise(resolve => setTimeout(resolve, this.statusPollMs))
    }
    // 期限到点与阶段进死胡同是两种不同的失败，报出来的话要能分辨是去查集群还是去改配置。
    if (signal.aborted) {
      throw new Error(`container-k8s: sandbox ${podName} was still ${describeStatus(last)} when its start deadline expired`)
    }
    throw new Error(`container-k8s: sandbox ${podName} entered ${describeStatus(last)}, a phase it cannot leave without being replaced`)
  }

  /**
   * 丢掉一个主体缓存的沙箱，并删掉它的 Pod。exec 传输失败与启动失败两条路径都到这里：
   * 下一次 `ensureSandbox` 会重新解析一个。
   *
   * 空闲回收不在这里：一个沙箱有没有人用，只有沙箱自己看得见——每个请求都要到达容器，
   * 而宿主的缓存只是「我上次拿到的那个地址」，多副本部署下它看不见别的副本正在用的沙箱，
   * 按缓存计时就会删掉别人正在使唤的 Pod。沙箱各自按 `idleTimeoutMs` 自行退出
   * （见 container-docker 的 `tool-exec.ts` 空闲 watchdog），这里只负责丢句柄。
   * @param key - (租户, subject) 作用域键。
   */
  private discard(key: string): void {
    const cached = this.sandboxes.get(key)
    if (cached === undefined) return
    this.sandboxes.delete(key)
    void this.releasePod(cached.podName).catch(() => {
      // Pod 已经不在了，或 apiserver 此刻不可达。两种情况下一次 exec 的冷启动都会覆盖，
      // 这次失败没有别的用处。
    })
  }

  /**
   * 收掉本 provider 标签下已经进入终态的沙箱 Pod：沙箱自己的空闲 watchdog 退出后留下的残骸，
   * 以及宿主非优雅退出时没来得及清理的那些。只碰终态阶段——Running/Pending 的 Pod 可能是
   * 另一个副本正在使用的沙箱，删它就是两个实例互相替换对方的工作。
   */
  private async reapTerminalSandboxes(): Promise<void> {
    // 标签与字段选择器合起来才是「本 provider 管、且已经走完」；缺失的 Pod 不算失败。
    for (const phase of ['Succeeded', 'Failed']) {
      const result = await this.runKubectl([
        'delete', 'pod', '-l', `${MANAGED_LABEL}=true`, '--field-selector', `status.phase=${phase}`,
        '--ignore-not-found', '--wait=false',
      ])
      // 收尸发生在上一次宿主进程结束之后，没有别的记录留下：说出删掉了哪些、停在哪个阶段，
      // 才知道一个沙箱是自己空闲退出（`Succeeded`）还是被节点杀掉（`Failed`）。
      const reaped = result.stdout.split('\n').filter(line => line.startsWith('pod '))
      if (reaped.length > 0) {
        this.ctx.logger.info(
          'container-k8s: reaped %d terminal sandbox pod(s) in phase %s: %s',
          reaped.length, phase, reaped.join(', '),
        )
      }
    }
  }

  /**
   * 删除一个沙箱 Pod。调用方不等待它消失：裸 Pod 没有控制器，下一次启动自己会重建它。
   * @param podName - 沙箱 Pod 名。
   * @param signal - 这次启动的期限，若在启动路径上调用。
   */
  private async releasePod(podName: string, signal?: AbortSignal): Promise<void> {
    await this.runKubectl(['delete', 'pod', podName, '--ignore-not-found', '--wait=false'], undefined, signal)
  }

  /**
   * 执行一条 `kubectl` 调用，带上命名空间与 `cliTimeoutMs` 的期限。
   *
   * 每条 kubectl 调用都走这里：kubectl 会一直阻塞到 apiserver 作答，只有期限能终止它，
   * 而没有期限的调用就是一次没有上界的等待。`container-docker` 的 `runCli` 是同一条规则。
   * @param args - `-n <命名空间>` 之后的参数。
   * @param stdin - 写给 `create -f -` 的清单文本。
   * @param signal - 外层启动期限，与这次调用自己的期限融在一起。
   * @returns 调用的退出码与捕获到的输出流。
   * @throws 调用超过 `cliTimeoutMs` 时，或外层期限已经耗尽时。
   */
  private async runKubectl(args: readonly string[], stdin?: string, signal?: AbortSignal): Promise<ContainerCommandResult> {
    const argv = ['-n', this.namespace, ...args]
    if (signal?.aborted === true) {
      throw new Error(`container-k8s: 'kubectl ${argv.join(' ')}' was not run: its deadline already expired`)
    }
    using d = deadline(signal, this.cliTimeoutMs, CLI_TIMEOUT)
    let result: ContainerCommandResult
    try {
      result = await this.runner.run(argv, { ...(stdin === undefined ? {} : { stdin }), signal: d.signal })
    } catch (error: unknown) {
      if (timeoutOf(d.signal, CLI_TIMEOUT) === undefined) throw error
      throw this.cliTimeoutError(argv)
    }
    // runner 把被期限杀掉的子进程报成退出码 0——被信号杀掉的过程没有自己的退出码——
    // 所以到点的期限才是这次调用没跑完的唯一证据。
    if (timeoutOf(d.signal, CLI_TIMEOUT) !== undefined) throw this.cliTimeoutError(argv)
    return result
  }

  /**
   * 一次超出期限的 CLI 调用对应的错误。
   * @param argv - 这次调用的完整参数向量。
   * @returns 说明这次调用没跑完的错误。
   */
  private cliTimeoutError(argv: readonly string[]): Error {
    return new Error(`container-k8s: 'kubectl ${argv.join(' ')}' did not finish within ${this.cliTimeoutMs}ms`)
  }
}

/** 沙箱一旦进入这些阶段就不会再自己走出来，只能重建。 */
const terminalPhases = new Set(['Failed', 'Succeeded', 'Missing'])

/**
 * 把状态渲染成一句可据以行动的话。
 * @param status - 最后一次观测到的状态。
 * @returns 单行说明。
 */
function describeStatus(status: SandboxStatus): string {
  const parts = [`phase=${status.phase}`, `ready=${status.ready}`]
  if (status.detail) parts.push(status.detail)
  return parts.join(' ')
}

/**
 * 从 `kubectl get pod -o json` 的输出推导状态。
 * @param json - Pod 文档。
 * @returns 阶段、就绪状态、IP、指纹，以及任何 waiting/terminated 原因。
 */
export function parsePodStatus(json: string): SandboxStatus {
  const pod = JSON.parse(json) as {
    status?: {
      phase?: string
      podIP?: string
      conditions?: { type: string; status: string }[]
      initContainerStatuses?: { state?: Record<string, { reason?: string; message?: string }> }[]
      containerStatuses?: { state?: Record<string, { reason?: string; message?: string }> }[]
    }
    metadata?: { annotations?: Record<string, string> }
  }
  const phase = pod.status?.phase ?? 'Unknown'
  const ready = (pod.status?.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True')
  const detail: string[] = []
  for (const group of [pod.status?.initContainerStatuses, pod.status?.containerStatuses]) {
    for (const container of group ?? []) {
      const state = container.state ?? {}
      for (const [kind, value] of Object.entries(state)) {
        if (kind === 'running' || kind === 'terminated' && !value.reason) continue
        if (value.reason || value.message) detail.push(`${kind}: ${value.reason ?? ''}${value.message ? ` (${value.message})` : ''}`.trim())
      }
    }
  }
  return {
    phase,
    ready,
    ...(pod.status?.podIP ? { podIP: pod.status.podIP } : {}),
    ...(pod.metadata?.annotations?.['dsh.dev/spec-fingerprint'] ? { fingerprint: pod.metadata.annotations['dsh.dev/spec-fingerprint'] } : {}),
    ...(detail.length > 0 ? { detail: detail.join('; ') } : {}),
  }
}

export default K8sContainerRuntime
