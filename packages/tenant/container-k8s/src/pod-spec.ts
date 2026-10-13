/**
 * 纯函数式地拼装一个沙箱 Pod 的 spec。这里每个取值都由配置与当前的 (租户, 用户)
 * 作用域推导而来，因此结果是其输入的确定性函数——spec 指纹与它的测试都依赖这一点。
 * @module @deepseek-ai/dsh-container-k8s/pod-spec
 */

import { createHash } from 'node:crypto'

/**
 * 一个挂载来源，以及它必须出现在沙箱内的绝对路径。
 *
 * 两个分支的区别只在数据存在哪里，而不在沙箱在哪里看见它们：调用方可以把某一层
 * 在节点目录与共享 claim 之间来回切换，而沙箱及其读取方解析到的路径一个都不用改。
 */
export type SandboxMount =
  | {
    /** 运行沙箱的那个节点上的目录。 */
    kind: 'hostPath'
    /**
       * 节点上的绝对路径。它必须与 {@link mountPath} 逐字符相等：
       * 两者一旦不同，Kubernetes 会悄悄造出一个空目录，
       * 而这种悄悄为空的挂载与「本来就是空的」工作区无法区分。
       */
    source: string
    mountPath: string
    readOnly: boolean
  }
  | {
    /** 与沙箱配对的那个 PersistentVolumeClaim 里的子目录。 */
    kind: 'claim'
    /** claim 在沙箱自己命名空间里的名字。 */
    claimName: string
    /** 相对 claim 根的路径；租户与用户的切分就落在这一段上。 */
    subPath: string
    mountPath: string
    readOnly: boolean
  }

/** 决定一个沙箱 Pod 完整 spec 的全部输入。 */
export interface SandboxPodInput {
  /** 创建 Pod 的 Kubernetes 命名空间。 */
  namespace: string
  /** 沙箱容器镜像引用。 */
  image: string
  /** 镜像拉取策略；`Never` 是气隙节点使用已导入镜像的方式。 */
  imagePullPolicy: string
  /** RFC1123 合规的 Pod 名，通常来自 {@link sandboxPodName}。 */
  podName: string
  /** tool-exec 服务入口执行的容器命令。 */
  command: readonly string[]
  /** 绑定来源及它们在沙箱内的路径。 */
  mounts: readonly SandboxMount[]
  /** 沙箱容器的显式环境变量。 */
  env: Readonly<Record<string, string>>
  /** host 访问 tool-exec 服务所用的容器端口。 */
  toolExecPort: number
  /**
   * 执行容器的工作目录：挂一个容器本地空目录到该路径。
   *
   * 容器根文件系统只读，工作目录必须是挂载点才存在；用 `emptyDir` 是因为模型的中间产物应当随
   * 沙箱销毁而消失。它与宿主的 `sandbox.workDir` 必须是同一个值。
   */
  workDir: string
  /** 可选的资源 requests 与 limits。 */
  resources?: Record<string, unknown>
}

/** 一份 Pod spec：结构完整，但对象层面刻意放宽了类型。 */
export interface SandboxPodSpec {
  apiVersion: 'v1'
  kind: 'Pod'
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> }
  spec: Record<string, unknown>
}

/** 沙箱 Pod 的托管标签：provider 收尸时只认它，与 container-docker 打在容器上的是同一个键值。 */
export const MANAGED_LABEL = 'dsh.dev/managed'
/** 承载沙箱空闲预算的环境变量名：镜像入口 `entry.mjs` 读它，`container-docker` 注入同名变量。 */
export const TOOL_EXEC_IDLE_ENV = 'DSH_TOOL_EXEC_IDLE_MS'
/** 承载沙箱输出上界的变量名：镜像入口 `entry.mjs` 读它，`container-docker` 注入同名变量。 */
export const TOOL_EXEC_MAX_OUTPUT_ENV = 'DSH_TOOL_EXEC_MAX_OUTPUT_BYTES'

/**
 * 为一个 (租户, 用户) 沙箱推导出符合 RFC1123 DNS label 规则的名字。
 *
 * Kubernetes 对象名只接受小写字母数字、`-` 和 `.`，而 DSH 的 subject 可能带下划线、
 * 大写字母或任意文字系统的字符。原始的那对值会原样保存在注解里，
 * 因此这个名字只是一个有损的把手，永远不是身份的来源。
 * @param tenantId - 租户标识，已由 DSH 限制过字符集。
 * @param subject - 租户内已认证的 subject。
 * @returns 不超过 63 个字符、可作为 Pod 名的名字。
 */
export function sandboxPodName(tenantId: string, subject: string): string {
  const digest = createHash('sha256').update(`${tenantId}\u0000${subject}`).digest('hex').slice(0, 12)
  const fold = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const head = fold(`dsh-${tenantId}-${subject}`).slice(0, 50).replace(/-+$/, '')
  return `${head || 'dsh'}-${digest}`
}

/**
 * 拼装某个 (租户, 用户) 作用域的沙箱 Pod spec。
 *
 * 这里用的是裸 Pod，而不是 Deployment、Job 或 StatefulSet：它没有控制器来重启自己，
 * 这正是运行时想要的——沙箱生命周期归 host 所有，host 收养已存在的 Pod 而不是替换它。
 *
 * init 容器会在 kubelet 挂载完成 *之后* 再逐个复核必需的挂载。宿主侧的存在性检查只能
 * 证明 host 读得到这个路径，这是沙箱能挂载它的必要条件而非充分条件；init 容器观察的是
 * 挂载结果本身，它一旦失败，Pod 就会一直进不了 `Running`。
 *
 * 一个卷对应一份后端存储，绝不对应一个挂载点。同一个 claim 的多个挂载点共用一条
 * `volumes` 记录，靠 `subPath` 区分，这是 kubelet 唯一接受的形式：它按后端卷记录挂载
 * 状态，所以同一个 claim 被写第二遍时，除了其中一条，其余永远停在「未挂载」，
 * Pod 也就永远过不了 init 容器。
 * @param input - 已解析的 spec 输入。
 * @returns Pod spec 及其指纹。
 */
export function buildSandboxPod(input: SandboxPodInput): { spec: SandboxPodSpec; fingerprint: string } {
  const annotations: Record<string, string> = {
    'dsh.dev/tool-exec-port': String(input.toolExecPort),
  }
  // 检查在沙箱内部执行，因此必须写沙箱看得见的路径——挂载路径，而不是宿主来源。
  // 两者不同时，宿主路径在容器文件系统里根本不存在，
  // 那样在一个完全健康的 host 上也会把每一个这类挂载判为失败。
  const initCheck = input.mounts
    .map(m => `[ -e "${m.mountPath}" ] || { echo "MISSING ${m.mountPath}"; exit 1; }`)
    .join('; ')
  const spec: SandboxPodSpec = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: input.podName,
      namespace: input.namespace,
      labels: { 'app.kubernetes.io/name': 'dsh-tool-exec', [MANAGED_LABEL]: 'true' },
      annotations,
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      initContainers: [
        {
          name: 'verify-mounts',
          image: input.image,
          imagePullPolicy: input.imagePullPolicy,
          command: ['/bin/sh', '-c', initCheck],
          // 校验容器读的东西必须和沙箱容器读的一样，因此挂载同一批位置：
          // 少了 subPath 的挂载检查会把 claim 的根当成租户自己的子树放过去。
          volumeMounts: input.mounts.map(m => mountSite(m, true)),
        },
      ],
      containers: [
        {
          name: 'tool-exec',
          image: input.image,
          imagePullPolicy: input.imagePullPolicy,
          command: [...input.command],
          // 排序是为了让指纹只取决于环境变量的内容，而不取决于提供它的对象里的插入顺序：
          // 指纹若对顺序敏感，两个读同一份配置的 host 就会对「运行中的沙箱是否还合时」
          // 得出不同结论。
          env: Object.entries(input.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => ({ name, value })),
          ports: [{ name: 'tool-exec', containerPort: input.toolExecPort }],
          // readOnlyRootFilesystem 让根文件系统没有任何可写之处；
          // 否则一条需要临时文件的命令会因为与它被要求做的事无关的原因失败。
          volumeMounts: [
            ...input.mounts.map(m => mountSite(m, m.readOnly)),
            { name: 'tmp', mountPath: '/tmp', readOnly: false },
            // 根文件系统只读，执行容器的工作目录必须是挂载点才存在。这一条给它一个容器本地的空
            // 目录：它随 Pod 销毁，模型按相对路径写出的中间产物不会落进任何 PVC。
            { name: 'work', mountPath: input.workDir, readOnly: false },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
            readOnlyRootFilesystem: true,
          },
          ...(input.resources ? { resources: input.resources } : {}),
        },
      ],
      volumes: [...volumesFor(input.mounts), { name: 'tmp', emptyDir: {} }, { name: 'work', emptyDir: {} }],
      tolerations: [{ operator: 'Exists' }],
    },
  }
  return { spec, fingerprint: fingerprintOf(spec) }
}

/**
 * 一个挂载所读数据的那份后端存储的身份。
 *
 * 卷按「数据从哪里读」来区分，绝不按「在沙箱里出现在哪里」：同一个 claim 的两个挂载点
 * 只是一个卷；若按挂载路径取键，那个 claim 就会得到两条 `volumes` 记录，
 * 而 kubelet 挂不上这样的 Pod。
 * @param mount - 一个已解析的挂载。
 * @returns 每份后端存储唯一的键。
 */
function backingOf(mount: SandboxMount): string {
  return mount.kind === 'claim' ? `claim:${mount.claimName}` : `path:${mount.source}`
}

/**
 * 把一个挂载投影成某个容器的 `volumeMounts` 记录。
 *
 * `subPath` 属于这里而不属于卷：Kubernetes 不接受卷上的 `subPath`，
 * 而同一个 claim 要在多个地址被读取时，每个地址需要的子目录都不一样。
 * @param mount - 一个已解析的挂载。
 * @param readOnly - 这个容器能否通过该挂载写入。
 * @returns 一条 `volumeMounts` 记录。
 */
function mountSite(mount: SandboxMount, readOnly: boolean): Record<string, unknown> {
  return {
    name: volumeName(backingOf(mount)),
    mountPath: mount.mountPath,
    readOnly,
    ...(mount.kind === 'claim' ? { subPath: mount.subPath } : {}),
  }
}

/**
 * 为挂载所读的每一份后端存储生成一条 `volumes` 记录。
 *
 * `hostPath.type` 取 `Directory`，来源缺失时挂载直接失败，而不是造出一个空目录。
 * claim 表达不了这件事：claim 存在时它下面的 `subPath` 会被建成空目录，
 * 所以 claim 模式的部署需要自己检查租户目录树是否存在，再创建 Pod。
 * @param mounts - 已解析的挂载列表。
 * @returns 卷列表，按首次出现的顺序。
 */
function volumesFor(mounts: readonly SandboxMount[]): Record<string, unknown>[] {
  const byBacking = new Map<string, Record<string, unknown>>()
  for (const mount of mounts) {
    const backing = backingOf(mount)
    if (byBacking.has(backing)) continue
    byBacking.set(
      backing,
      mount.kind === 'hostPath'
        ? { name: volumeName(backing), hostPath: { path: mount.source, type: 'Directory' } }
        : { name: volumeName(backing), persistentVolumeClaim: { claimName: mount.claimName } },
    )
  }
  return [...byBacking.values()]
}

/**
 * 一份后端存储的稳定卷名。
 *
 * 卷名与 Pod 名一样受 RFC1123 label 规则约束，因此后端存储用同样的方式折叠，
 * 再用 *原始* 取值的摘要消歧——只靠折叠会把两份不同的存储撞到同一个名字上。
 * @param backing - 来自 {@link backingOf} 的后端存储身份。
 * @returns 符合 DNS label 规则的卷名。
 */
export function volumeName(backing: string): string {
  const digest = createHash('sha256').update(backing).digest('hex').slice(0, 8)
  return `v-${backing.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase()}-${digest}`
}

/**
 * 一份已解析 Pod spec 的内容指纹。
 *
 * 它以注解的形式记录下来，好让之后的 host 进程区分「这个 Pod 就是我会创建的那个」与
 * 「这个 Pod 已经过期」——这正是 host 重启后收养沙箱而不是重建它的全部依据。
 * @param spec - 已拼装好的 spec。
 * @returns 对 spec 的规范序渲染取摘要所得的十六进制值。
 */
export function fingerprintOf(spec: SandboxPodSpec): string {
  return createHash('sha256').update(canonicalize(spec)).digest('hex')
}

/**
 * 把取值渲染成对象键有序的形式。
 *
 * JSON.stringify 会保留插入顺序，否则两条由不同代码路径拼出、结构却相同的 spec
 * 会得到不同的指纹。
 * @param value - 任何可被 JSON 表示的取值。
 * @returns 稳定的字符串渲染。
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}
