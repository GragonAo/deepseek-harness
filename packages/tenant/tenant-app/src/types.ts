/**
 * 租户服务的启动配置类型。
 *
 * 这里只放类型：全部字段在 {@link loadTenantAppConfig} 里解析并校验。配置的归属很明确——
 * 凡是随部署而变的取值都在这里，代码里不留任何写死的端口、镜像、命名空间、路径或开关。
 * @module @deepseek-ai/dsh-tenant-app/types
 */

import type { ToolConcurrencyConfig } from '@deepseek-ai/dsh-mcp-client'
import type { ToolPresentationMode } from '@deepseek-ai/dsh-tools'

/** HTTP 监听配置。 */
export interface HttpConfig {
  /** 监听地址；`0.0.0.0` 表示所有网卡。 */
  readonly host: '127.0.0.1' | '0.0.0.0'
  /** 监听端口；`0` 由系统分配（测试用）。 */
  readonly port: number
}

/** 数据库配置。租户、用户、会话、设置与凭据都落在同一个 PostgreSQL 实例的各自分区里。 */
export interface DatabaseConfig {
  /** 承载所有租户分区的 PostgreSQL 连接串。 */
  readonly connectionString: string
}

/** 凭据校验配置，对应 `ctx.tenantAuth` 的 JWT provider。 */
export interface AuthConfig {
  /** 令牌的签发者（`iss`），必须匹配。 */
  readonly issuer: string
  /** 校验方式：`jwks` 走 RS256 的远程公钥集，`secret` 走 HS256 共享密钥；二者必须恰好给一个。 */
  readonly verify: JwksVerifyConfig | SharedSecretVerifyConfig
  /** 期望的受众（`aud`）；给了就必须匹配。 */
  readonly audience?: string
  /** 令牌里承载租户 id 的声明名；平台凭据没有这个声明。 */
  readonly tenantIdClaim?: string
  /** 允许的时钟偏移秒数。 */
  readonly clockToleranceSeconds?: number
}

/** RS256 + JWKS 校验。 */
export interface JwksVerifyConfig {
  readonly kind: 'jwks'
  /** 公钥集地址。 */
  readonly jwksUri: string
}

/** HS256 + 共享密钥校验（本地开发与内网联调用）。 */
export interface SharedSecretVerifyConfig {
  readonly kind: 'secret'
  /** 共享密钥。 */
  readonly secret: string
}

/** 管理面配置。 */
export interface AdminConfig {
  /** 准入管理面的 OIDC 作用域；管理面的每个方法都要它，且不需要任何租户。 */
  readonly scope: string
}

/** 租户与用户目录的根，以及新建租户时的默认值。 */
export interface TenantsConfig {
  /** 每个主体一个子目录的根，作为它们的跨案件全局目录（沙箱内 `/global`）。 */
  readonly usersRoot: string
  /** `purge` 时把租户目录移入的归档根。 */
  readonly archiveRoot: string
  /** 新建租户的默认取值；`/admin/tenants.create` 未显式给出的字段取这里的值。 */
  readonly defaults: TenantDefaultsConfig
}

/** 新建租户的默认取值。 */
export interface TenantDefaultsConfig {
  /** 租户持久数据根：容器/会话之外的文件都落在这里。 */
  readonly dataRoot: string
  /** 租户工作区根，也是沙箱 `/workspace` 的绑定挂载源。 */
  readonly workspaceRoot: string
  /** 租户工具图谱根，只读挂载到沙箱 `/tools`；不配则用容器镜像自带的工具。 */
  readonly toolsRoot?: string
  /** 租户沙箱的出网策略。 */
  readonly network: 'none' | 'internal'
}

/** 沙箱配置：本地开发用 docker，生产用 k8s。两个后端共享同一组语义，差异只在启动方式。 */
export type SandboxConfig = DockerSandboxConfig | K8sSandboxConfig

/** 与后端无关的分层挂载配置：两个后端都按同一规则挂载同一个路径。 */
export interface SandboxLayersConfig {
  /**
   * 执行容器里的工作目录：会话按它解析相对路径，模型不写绝对路径时的产物落在这里。
   *
   * 它必须是容器本地的路径而不是挂载点，中间产物才会随沙箱销毁而消失；要交给用户的交付物由
   * 模型显式写到挂载的 `/workspace`，再由发布工具送出。两个后端按同一规则使用它。
   */
  readonly workDir?: string
  /**
   * `/case`（案件工作目录）是否对沙箱只读，省略即只读。
   *
   * 它由一个案件下的所有用户共用，业务侧通过管理接口写入；沙箱可写就意味着任何用户的沙箱都能
   * 改到别人的输入，而且 `/skills` 就在它下面，那一层只读的技能挂载会失去意义。
   */
  readonly caseReadOnly?: boolean
  /**
   * `/global`（该 subject 的跨案件目录）是否对沙箱只读，省略即只读。
   *
   * 它盛放用户全局提交上来的文件与用户全局技能，由业务侧写入；`/global/skills` 同样在它下面。
   */
  readonly usersReadOnly?: boolean
  /** 全局 skill 树所在的宿主目录，只读挂载到沙箱内的同一绝对路径。 */
  readonly systemRoot?: string
  /** 沙箱内命令使用的 Python 运行时目录，只读挂载并配置 PATH/VIRTUAL_ENV/PYTHONPATH。 */
  readonly pythonRoot?: string
  /** 三级工具清单所在的目录；租户记录自带 `toolsRoot` 时以记录为准。 */
  readonly toolsRoot?: string
  /** 空闲多久回收一个沙箱，单位毫秒；不配则常驻。 */
  readonly idleTimeoutMs?: number
  /** 解析出的沙箱句柄缓存多久，单位毫秒；过期后重新解析。 */
  readonly sandboxCacheTtlMs?: number
  /** 冷启动的整体上限，单位毫秒；超时后清掉该主体的缓存，下一次调用重新冷启动。 */
  readonly startTimeoutMs?: number
  /** 单次命令的超时上限，单位毫秒。 */
  readonly toolTimeoutMs?: number
  /** 沙箱内每次 exec 里每条输出流最多保留多少字节；省略则用 provider 的默认值 67108864。 */
  readonly maxOutputBytes?: number
  /** 单次容器 CLI 调用（`docker`/`podman`/`kubectl`）的时间上限，单位毫秒。 */
  readonly cliTimeoutMs?: number
  /** 冷启动后等待沙箱内 tool-exec 服务答话的时间上限，单位毫秒。 */
  readonly readyTimeoutMs?: number
  /** 上面那次等待每次重试之间的间隔，单位毫秒。 */
  readonly readyPollMs?: number
}

/** Docker/Podman 后端。 */
export interface DockerSandboxConfig extends SandboxLayersConfig {
  readonly backend: 'docker'
  /** 容器 CLI：`docker` 或 `podman`。 */
  readonly runtime?: 'docker' | 'podman'
  /** 沙箱使用的容器网络名。 */
  readonly network?: string
  /** 承载沙箱内 tool-exec 服务的镜像。 */
  readonly image?: string
  /** tool-exec 服务在容器里监听的端口。 */
  readonly toolExecPort?: number
  /** 发布 tool-exec 端口时绑定的宿主地址。 */
  readonly publishHost?: string
  /** 宿主要连接已发布端口时使用的地址。 */
  readonly connectHost?: string
  /** tool-exec 镜像给命令的 `PATH`；配了 `pythonRoot` 时必须与镜像一致。 */
  readonly imagePath?: string
  /** 内存上限（Docker 语法，如 `2g`）；不配则不限。 */
  readonly memoryLimit?: string
  /** CPU 上限（整核数）；不配则不限。 */
  readonly cpuLimit?: number
}

/** Kubernetes 后端。 */
export interface K8sSandboxConfig extends SandboxLayersConfig {
  readonly backend: 'k8s'
  /** 沙箱 Pod 所在命名空间；只在这一个命名空间里创建、读取、删除 Pod。 */
  readonly namespace: string
  /** 沙箱容器镜像；必须已存在于节点上或被集群拉得到。 */
  readonly image: string
  /** `kubectl` 可执行文件名或绝对路径。 */
  readonly kubectlBinary?: string
  /** 沙箱容器的镜像拉取策略。 */
  readonly imagePullPolicy?: string
  /** 沙箱内 tool-exec 服务监听的容器端口。 */
  readonly toolExecPort?: number
  /** 承载各分层目录的 PersistentVolumeClaim。 */
  readonly workspaceClaim: string
  /** 该 claim 在本进程看到的挂载点，也是每个挂载源换算 `subPath` 的根。 */
  readonly claimRoot: string
  /** 全局 skill 树所在的节点目录或 claim 子路径，只读挂载到沙箱内同一路径。 */
  readonly systemRoot: string
  /** 沙箱内命令使用的 Python 运行时目录。 */
  readonly pythonRoot: string
  /** 承载三级工具清单的目录。 */
  readonly toolsRoot: string
  /** 沙箱内 Python 的三条路径：宿主读不到节点目录，所以由配置显式给出。 */
  readonly pythonEnv: {
    readonly binDir: string
    readonly virtualEnv: string
    readonly sitePackages: string
  }
  /** 每个沙箱里启动的容器命令；省略则用镜像 entrypoint 的 `['node', 'entry.mjs']`。 */
  readonly command?: readonly string[]
  /** 沙箱容器的显式环境变量。身份变量（`DSH_CASE_ID`/`DSH_TENANT_ID`/`DSH_USER_ID`）与 Python 三件套由 provider 在此之后写入，覆盖不了它们。 */
  readonly env?: Readonly<Record<string, string>>
  /** tool-exec 镜像给命令的 `PATH`；须与镜像一致。 */
  readonly imagePath?: string
  /** 内存上限（Kubernetes quantity 写法，如 `8Gi`）；不配则不限，此时沙箱 Pod 落在 BestEffort。 */
  readonly memoryLimit?: string
  /** CPU 上限（整核数）；不配则不限。 */
  readonly cpuLimit?: number
  /** `kubectl` 单次调用的上限，单位毫秒。 */
  readonly cliTimeoutMs?: number
  /** 轮询 Pod 阶段的间隔，单位毫秒。 */
  readonly statusPollMs?: number
  /** 等待沙箱就绪的上限与间隔，单位毫秒。 */
  readonly readyTimeoutMs?: number
  readonly readyPollMs?: number
}

/** 文件与命令的权限策略。 */
export interface PermissionsConfig {
  /** 沙箱策略档位；`workspace-write` 只允许在工作区内写。 */
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 需要模型确认的动作如何处理；默认按 `mode` 推导（`danger-full-access` 不问）。 */
  readonly approval?: 'never' | 'ask'
}

/** 默认模型配置。 */
export interface ModelConfig {
  /** 供应商标识。 */
  readonly provider: string
  /** 模型标识。 */
  readonly model: string
}

/** 联网检索配置。 */
export interface WebConfig {
  /** 检索服务读取 API key 的环境变量名。 */
  readonly searchApiKeyEnv: string
}

/** 遥测配置。 */
export interface TelemetryConfig {
  /** `DISABLED` 关闭上报；`OTLP` 上报到 {@link url}。 */
  readonly mode: 'DISABLED' | 'OTLP'
  /** OTLP 采集端点；`mode: 'OTLP'` 时必填。 */
  readonly url?: string
}

/** 附带的浏览器界面开关（管理面与业务面各自的线协议参考）。 */
export interface SurfacesConfig {
  /** 业务面是否提供 `GET /api/openapi.json` 与 `/api/swagger`。 */
  readonly openapi?: boolean
  /** 业务面是否提供运维控制台 `GET /api/console`。 */
  readonly console?: boolean
  /** 管理面是否提供 `GET /admin/openapi.json`。 */
  readonly adminOpenapi?: boolean
}

/** 工具呈现方式与工具并发；两项都由部署决定，不给则用租户栈的默认值。 */
export interface ToolsConfig {
  /**
   * 呈现方式：`code` 只把 `run_code` 加上生成的 SDK 类型声明交给模型，`native` 逐份下发原生 schema，
   * `both` 两者都给。默认 `both`：读一个文件、问一句的会话不必先写程序；工具数以百计时原生 schema
   * 的成本由案件目录里的 `restriction.yaml` 收窄可见工具来压，两种形态一起变小。
   */
  readonly mode?: ToolPresentationMode
  /** `run_code` 程序里重叠子调用的并发上限；必须是正整数。默认 32。 */
  readonly maxParallelSubCalls?: number
}

/** 单个组合行的覆盖：停用或追加配置。 */
export interface PluginOverride {
  /** 是否挂载这一行；`false` 表示不挂载。 */
  readonly enabled?: boolean
  /** 追加到该行默认配置之上的字段。 */
  readonly config?: Readonly<Record<string, unknown>>
}

/** 一个 MCP 服务器的接入配置。 */
export interface McpServerConfig {
  /** 服务器名，决定注册出来的工具名前缀。 */
  readonly serverName: string
  /**
   * 传输方式。租户配置只承载 Streamable HTTP 这一支：`@deepseek-ai/dsh-mcp-client` 的
   * `Config` 是 `stdio` / `streamable-http` 的判别联合，而宿主上挂的 MCP 服务都是网络入口，
   * 不需要由租户配置去起子进程。
   */
  readonly transport: 'streamable-http'
  /** 服务器地址。 */
  readonly url: string
  /** 附在 MCP 请求上的额外请求头，认证走这里（与 `@deepseek-ai/dsh-mcp-client` 同名同义）。 */
  readonly headers?: Readonly<Record<string, string>>
  /** 该服务器的工具调用并发；结构与 `@deepseek-ai/dsh-mcp-client` 的同名字段相同，省略则由它补默认值。 */
  readonly toolConcurrency?: ToolConcurrencyConfig
  /** 单次工具调用的超时（毫秒，与 `@deepseek-ai/dsh-mcp-client` 同名同义），省略由它补默认值。 */
  readonly toolCallTimeoutMs?: number
  /**
   * 初次连接或工具同步失败时是否让这一行的挂载失败。客户端的默认值是 `false`：那时它只记一条
   * 日志并进入重连，一个写错的地址会安静地表现为“这个 server 没有工具”。
   */
  readonly failOnStartupError?: boolean
}

/** 租户服务的完整启动配置：所有随部署而变的值都在这里。 */
export interface TenantAppConfig {
  /** HTTP 监听配置。 */
  readonly http: HttpConfig
  /** 数据库配置。 */
  readonly database: DatabaseConfig
  /** 凭据校验配置。 */
  readonly auth: AuthConfig
  /** 管理面配置。 */
  readonly admin: AdminConfig
  /** 租户与用户目录的根，以及新建租户的默认值。 */
  readonly tenants: TenantsConfig
  /** 沙箱配置：docker（本地）或 k8s（生产）。 */
  readonly sandbox: SandboxConfig
  /** 文件与命令的权限策略；不给则按 `workspace-write` 起步。 */
  readonly permissions?: PermissionsConfig
  /** 默认模型；不给则用租户栈的默认供应商与模型。 */
  readonly model?: ModelConfig
  /** 联网检索配置。 */
  readonly web?: WebConfig
  /** 遥测配置；不给则不上报。 */
  readonly telemetry?: TelemetryConfig
  /** 附带界面的开关。 */
  readonly surfaces?: SurfacesConfig
  /** 工具呈现方式与工具并发上限。 */
  readonly tools?: ToolsConfig
  /** 逐行覆盖组合清单：停用某一行或追加它的配置。 */
  readonly plugins?: Readonly<Record<string, PluginOverride>>
  /** 要接入的 MCP 服务器。 */
  readonly mcpServers?: readonly McpServerConfig[]
}

/** 已启动的租户服务。 */
export interface TenantApp {
  /** 组合出来的 Cordis 上下文。 */
  readonly ctx: import('@deepseek-ai/cordis').Context
  /** 实际监听的端口。 */
  readonly port: number
  /** 释放整个组合：HTTP 服务、沙箱、数据库连接池与全部注册。 */
  dispose(): Promise<void>
}
