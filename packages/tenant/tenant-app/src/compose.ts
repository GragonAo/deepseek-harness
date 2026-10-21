/**
 * 组合：把租户服务要用到的插件挂到一个自建的 Cordis 上下文上。
 *
 * 这里不经过 dsh 的 Loader、bundle 与 cordis.yml：配置由 {@link loadTenantAppConfig}
 * 校验，挂载顺序就是这份函数的顺序，可执行入口只有 `bin.ts` 一个。dsh 的核心层（会话、agent、
 * 工具、技能、能力位）仍然是被挂载的插件，租户栈只是把它们聚到自己的组合里。
 * @module @deepseek-ai/dsh-tenant-app/compose
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber, Plugin } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { TenantRegistry } from '@deepseek-ai/dsh-tenant'
import { JwtTenantAuthenticator } from '@deepseek-ai/dsh-tenant-auth-jwt'
import type { Config as JwtTenantAuthConfig } from '@deepseek-ai/dsh-tenant-auth-jwt'
import { TenantAdmin } from '@deepseek-ai/dsh-tenant-admin'
import { TenantAdminHttp } from '@deepseek-ai/dsh-tenant-admin-http'
import { AgentHttp } from '@deepseek-ai/dsh-agent-http'
import { TenantFsHttp } from '@deepseek-ai/dsh-tenant-fs-http'
import { DockerContainerRuntime } from '@deepseek-ai/dsh-container-docker'
import { K8sContainerRuntime } from '@deepseek-ai/dsh-container-k8s'
import { ContainerSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-container'
import { ContainerFileSystem } from '@deepseek-ai/dsh-fs-container'
import { PostgresSessionPersistence } from '@deepseek-ai/dsh-session-persistence-postgres'
import { SPINE, workDir } from './spine.ts'
import type { SpineRow } from './spine.ts'
import type { McpServerConfig, TenantApp, TenantAppConfig } from './types.ts'

/**
 * 按配置启动租户服务。
 * @param config - 已校验的启动配置。
 * @returns 已启动的服务；`dispose()` 释放整个组合。
 */
export async function createTenantApp(config: TenantAppConfig): Promise<TenantApp> {
  const ctx = new Context()
  const mounted: Mounted[] = []
  for (const entry of staticMounts(config)) {
    const what = `静态挂载 ${entry.id}`
    mounted.push({ what, fiber: await mountLabeled(what, () => entry.mount(ctx)) })
  }
  for (const row of SPINE) {
    const fiber = await mountSpineRow(ctx, row, config)
    if (fiber !== undefined) mounted.push({ what: `组合行 ${row.id}（${row.module}）`, fiber })
  }
  for (const [index, server] of (config.mcpServers ?? []).entries()) {
    const id = `mcp-${index}-${server.serverName}`
    mounted.push({
      what: `组合行 ${id}（@deepseek-ai/dsh-mcp-client）`,
      fiber: await mountModule(ctx, id, '@deepseek-ai/dsh-mcp-client', mcpServerMountConfig(server)),
    })
  }
  try {
    await assertLoaded(mounted)
    assertMountedServices(ctx, config)
  } catch (error) {
    // 启动失败：把已经挂上的块收回去，不给调用方留一个开着监听端口、连着数据库的半成品。
    // 释放自己出错只记日志，不替换掉「哪一块启动失败」——那是调用方唯一能拿去修的信息。
    await ctx.fiber.dispose().catch((reason: unknown) => {
      ctx.logger.error(reason)
    })
    throw error
  }

  const port = ctx.webServer.port
  let disposed = false
  return {
    ctx,
    port,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await ctx.fiber.dispose()
    },
  }
}

/** 组合里已挂上的一块插件与它的 fiber：启动末尾用它核对这一块真的加载成功了。 */
interface Mounted {
  /** 诊断里指认这一块的名字，例如 `组合行 tools-restriction（@deepseek-ai/dsh-tools-restriction）`。 */
  readonly what: string
  readonly fiber: Fiber
}

/**
 * 每一块已挂上的插件都等它执行完，失败就指名那一块。
 *
 * 带 `inject` 的插件，它的 `apply` 是否在 `ctx.plugin()` 返回前跑完取决于注入何时被提供：注入当时
 * 就在，`ctx.plugin()` 会等出结果并抛错；注入要等后面的某一块挂上才有，`apply` 就被推迟到那个
 * epoch，那时 `ctx.plugin()` 早已返回，失败只落在 fiber 上并打一条日志，服务照常起来。所以这一段
 * 必须放在所有块都挂完之后：那一刻注入都已提供，被推迟的 `apply` 要么已经跑完、要么已经在途，
 * `fiber.await()` 会等它结束并把它记录的错误重抛（`vendor/cordis/src/fiber.ts` 的 `Fiber.await`）。
 *
 * 注入永远不满足的块不算失败：它是 PENDING，缺哪个服务由 {@link assertMountedServices} 报出。
 */
async function assertLoaded(mounted: readonly Mounted[]): Promise<void> {
  for (const entry of mounted) {
    try {
      await entry.fiber.await()
    } catch (error) {
      throw new Error(`${entry.what}（注入满足后才执行）启动失败：${(error as Error).message}`, { cause: error })
    }
  }
}

/**
 * 挂一块插件：加载或启动失败都指名这一块，不让失败以裸错误的形式冒到调用方。
 * @param what - 诊断里指认这一块的名字。
 * @param load - 真正的挂载动作。
 * @returns 这一块的 fiber。
 */
async function mountLabeled(what: string, load: () => Promise<Fiber>): Promise<Fiber> {
  try {
    return await load()
  } catch (error) {
    throw new Error(`${what}启动失败：${(error as Error).message}`, { cause: error })
  }
}

/**
 * 一个 MCP 服务器挂成一个 `mcp-client` 实例时的配置。
 *
 * 每一项都只在租户配置给出时透传：省略就交给 `mcp-client` 自己的默认值，不在这里替它兜一个——
 * 同一个值在两侧各有一个默认值，只会让部署读到的生效值取决于谁写得更晚。
 * @param server - 租户配置里的一条 MCP 服务器。
 * @returns 传给 `@deepseek-ai/dsh-mcp-client` 的插件配置。
 */
function mcpServerMountConfig(server: McpServerConfig): Record<string, unknown> {
  return {
    serverName: server.serverName,
    transport: server.transport,
    url: server.url,
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
    ...(server.toolConcurrency !== undefined ? { toolConcurrency: server.toolConcurrency } : {}),
    ...(server.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: server.toolCallTimeoutMs } : {}),
    ...(server.failOnStartupError !== undefined ? { failOnStartupError: server.failOnStartupError } : {}),
  }
}

/**
 * 启动后必须存在的服务。
 *
 * Cordis 对注入不满足的插件是**静默跳过**的：少一个提供者，依赖它的整块插件就不挂，
 * 服务照常起来却少了一个面（业务面 `/api` 就是这么整块消失的）。所以启动末尾核对一次，
 * 缺谁就报谁。`row` 给出该服务的提供行：只有那一行启用时才要求服务存在，其余行停用
 * （例如只挂骨架的测试）不误报。
 */
const REQUIRED_SERVICES: readonly {
  readonly probe: (ctx: Context) => unknown
  readonly what: string
  readonly row: string | null
}[] = [
  { probe: ctx => ctx.get('webServer'), what: 'HTTP 面的宿主', row: null },
  { probe: ctx => ctx.get('sessions'), what: '会话存储', row: null },
  { probe: ctx => ctx.get('tenantAuth'), what: '租户准入', row: null },
  { probe: ctx => ctx.get('tenantAdmin'), what: '租户管理', row: null },
  { probe: ctx => ctx.get('skillInstall'), what: '技能包安装', row: 'skill-install' },
  { probe: ctx => ctx.get('apiProxy'), what: '业务面的 RPC 网关', row: 'api-gateway' },
  { probe: ctx => ctx.get('agentHttp'), what: '业务面 /api', row: 'api-gateway' },
  { probe: ctx => ctx.get('tenantFsHttp'), what: '业务面 /files', row: null },
  { probe: ctx => ctx.get('userQuestions'), what: '提问通道的能力缝', row: 'user-questions' },
  { probe: ctx => ctx.get('tenantQuestions'), what: '租户提问通道', row: 'tenant-questions' },
  { probe: ctx => ctx.get('directoryPicker'), what: '工作目录选择', row: 'directory-picker-browse' },
]

/** 核对启动后的服务清单；缺一个就抛错，指到提供它的那一行。 */
function assertMountedServices(ctx: Context, config: TenantAppConfig): void {
  const missing = REQUIRED_SERVICES
    .filter(required => required.row === null || spineRowMounted(config, required.row))
    .filter(required => required.probe(ctx) === undefined)
  if (missing.length === 0) return
  const names = missing.map(required => `${required.what}（${required.row ?? '静态挂载'}）`).join('、')
  throw new Error(`组合里缺少这些服务：${names}。提供它们的插件因为注入没被满足而未挂上，检查组合清单里对应的行`)
}

/** 组合清单里某一行是否会被挂上，与 {@link mountSpineRow} 同一条件。 */
function spineRowMounted(config: TenantAppConfig, id: string): boolean {
  const row = SPINE.find(candidate => candidate.id === id)
  if (row === undefined) return false
  const override = config.plugins?.[id]
  return override?.enabled === true || (override?.enabled === undefined && row.disabled === undefined)
}

/** 一次静态挂载：`id` 用于诊断，`mount` 是挂载本身。 */
interface StaticMount {
  readonly id: string
  readonly mount: (ctx: Context) => Promise<Fiber>
}

/** 需要静态类型的那几块：类插件直接挂，配置来自租户配置的对应小节。 */
function staticMounts(config: TenantAppConfig): readonly StaticMount[] {
  const sandbox = config.sandbox
  return [
    { id: 'web-server', mount: async ctx => ctx.plugin(WebServer, { host: config.http.host, port: config.http.port }) },
    { id: 'session-store', mount: async ctx => ctx.plugin(SessionStore) },
    { id: 'tenant-registry', mount: async ctx => ctx.plugin(TenantRegistry) },
    { id: 'tenant-auth-jwt', mount: async ctx => ctx.plugin(JwtTenantAuthenticator, jwtConfig(config)) },
    {
      id: 'tenant-admin',
      mount: async ctx => ctx.plugin(TenantAdmin, {
        adminScope: config.admin.scope,
        usersRoot: config.tenants.usersRoot,
        archiveRoot: config.tenants.archiveRoot,
        ...(sandbox.systemRoot !== undefined ? { systemRoot: sandbox.systemRoot } : {}),
        ...(sandbox.pythonRoot !== undefined ? { pythonRoot: sandbox.pythonRoot } : {}),
      }),
    },
    {
      id: 'tenant-admin-http',
      mount: async ctx => ctx.plugin(TenantAdminHttp, {
        adminScope: config.admin.scope,
        ...(config.surfaces?.adminOpenapi !== undefined ? { openapi: config.surfaces.adminOpenapi } : {}),
      }),
    },
    {
      id: 'agent-http',
      mount: async ctx => ctx.plugin(AgentHttp, {
        ...(config.surfaces?.openapi !== undefined ? { openapi: config.surfaces.openapi } : {}),
        ...(config.surfaces?.console !== undefined ? { console: config.surfaces.console } : {}),
      }),
    },
    {
      id: 'tenant-fs-http',
      mount: async ctx => ctx.plugin(TenantFsHttp, {
        usersRoot: config.tenants.usersRoot,
        ...(sandbox.systemRoot !== undefined ? { systemRoot: sandbox.systemRoot } : {}),
      }),
    },
    {
      id: 'session-persistence-postgres',
      mount: async ctx => ctx.plugin(PostgresSessionPersistence, { connectionString: config.database.connectionString }),
    },
    { id: 'subprocess-container', mount: async ctx => ctx.plugin(ContainerSubprocessRuntime) },
    { id: 'fs-container', mount: async ctx => ctx.plugin(ContainerFileSystem) },
    {
      id: 'container-runtime',
      mount: async ctx => sandbox.backend === 'docker'
        ? ctx.plugin(DockerContainerRuntime, dockerConfig(config))
        : ctx.plugin(K8sContainerRuntime, k8sConfig(config)),
    },
  ]
}

/** 认证插件的配置：校验方式二选一，其余字段按是否给出传递。 */
function jwtConfig(config: TenantAppConfig): JwtTenantAuthConfig {
  const auth = config.auth
  return {
    issuer: auth.issuer,
    ...(auth.verify.kind === 'jwks' ? { jwksUri: auth.verify.jwksUri } : { secret: auth.verify.secret }),
    ...(auth.audience !== undefined ? { audience: auth.audience } : {}),
    ...(auth.tenantIdClaim !== undefined ? { tenantIdClaim: auth.tenantIdClaim } : {}),
    ...(auth.clockToleranceSeconds !== undefined ? { clockToleranceSeconds: auth.clockToleranceSeconds } : {}),
  }
}

/** Docker 后端的配置：分层挂载、镜像、网络与生命周期全部来自租户配置。 */
function dockerConfig(config: TenantAppConfig): Record<string, unknown> {
  const sandbox = config.sandbox
  if (sandbox.backend !== 'docker') throw new Error('沙箱后端不是 docker')
  return {
    usersRoot: config.tenants.usersRoot,
    caseReadOnly: sandbox.caseReadOnly ?? true,
    usersReadOnly: sandbox.usersReadOnly ?? true,
    ...(sandbox.systemRoot !== undefined ? { systemRoot: sandbox.systemRoot } : {}),
    ...(sandbox.pythonRoot !== undefined ? { pythonRoot: sandbox.pythonRoot } : {}),
    ...(sandbox.toolsRoot !== undefined ? { toolsRoot: sandbox.toolsRoot } : {}),
    ...(sandbox.runtime !== undefined ? { runtime: sandbox.runtime } : {}),
    ...(sandbox.network !== undefined ? { network: sandbox.network } : {}),
    ...(sandbox.image !== undefined ? { toolExecImage: sandbox.image } : {}),
    ...(sandbox.toolExecPort !== undefined ? { toolExecPort: sandbox.toolExecPort } : {}),
    ...(sandbox.publishHost !== undefined ? { publishHost: sandbox.publishHost } : {}),
    ...(sandbox.connectHost !== undefined ? { connectHost: sandbox.connectHost } : {}),
    ...(sandbox.imagePath !== undefined ? { toolExecImagePath: sandbox.imagePath } : {}),
    ...(sandbox.memoryLimit !== undefined ? { memoryLimit: sandbox.memoryLimit } : {}),
    ...(sandbox.cpuLimit !== undefined ? { cpuLimit: sandbox.cpuLimit } : {}),
    ...(sandbox.idleTimeoutMs !== undefined ? { idleTimeoutMs: sandbox.idleTimeoutMs } : {}),
    ...(sandbox.sandboxCacheTtlMs !== undefined ? { sandboxCacheTtlMs: sandbox.sandboxCacheTtlMs } : {}),
    ...(sandbox.startTimeoutMs !== undefined ? { startTimeoutMs: sandbox.startTimeoutMs } : {}),
    ...(sandbox.toolTimeoutMs !== undefined ? { transportTimeoutMs: sandbox.toolTimeoutMs } : {}),
    ...(sandbox.maxOutputBytes !== undefined ? { maxOutputBytes: sandbox.maxOutputBytes } : {}),
    ...(sandbox.cliTimeoutMs !== undefined ? { cliTimeoutMs: sandbox.cliTimeoutMs } : {}),
    ...(sandbox.readyTimeoutMs !== undefined ? { readyTimeoutMs: sandbox.readyTimeoutMs } : {}),
    ...(sandbox.readyPollMs !== undefined ? { readyPollMs: sandbox.readyPollMs } : {}),
  }
}

/** Kubernetes 后端的配置：与 docker 后端同一组语义，只差启动方式。 */
function k8sConfig(config: TenantAppConfig): Record<string, unknown> {
  const sandbox = config.sandbox
  if (sandbox.backend !== 'k8s') throw new Error('沙箱后端不是 k8s')
  return {
    namespace: sandbox.namespace,
    image: sandbox.image,
    workspaceClaim: sandbox.workspaceClaim,
    claimRoot: sandbox.claimRoot,
    workDir: workDir(config),
    caseReadOnly: sandbox.caseReadOnly ?? true,
    usersReadOnly: sandbox.usersReadOnly ?? true,
    usersRoot: config.tenants.usersRoot,
    systemRoot: sandbox.systemRoot,
    pythonRoot: sandbox.pythonRoot,
    toolsRoot: sandbox.toolsRoot,
    pythonEnv: sandbox.pythonEnv,
    ...(sandbox.command !== undefined ? { command: [...sandbox.command] } : {}),
    ...(sandbox.env !== undefined ? { env: { ...sandbox.env } } : {}),
    ...(sandbox.kubectlBinary !== undefined ? { kubectlBinary: sandbox.kubectlBinary } : {}),
    ...(sandbox.imagePullPolicy !== undefined ? { imagePullPolicy: sandbox.imagePullPolicy } : {}),
    ...(sandbox.toolExecPort !== undefined ? { toolExecPort: sandbox.toolExecPort } : {}),
    ...(sandbox.imagePath !== undefined ? { toolExecImagePath: sandbox.imagePath } : {}),
    ...(sandbox.memoryLimit !== undefined ? { memoryLimit: sandbox.memoryLimit } : {}),
    ...(sandbox.cpuLimit !== undefined ? { cpuLimit: sandbox.cpuLimit } : {}),
    ...(sandbox.cliTimeoutMs !== undefined ? { cliTimeoutMs: sandbox.cliTimeoutMs } : {}),
    ...(sandbox.statusPollMs !== undefined ? { statusPollMs: sandbox.statusPollMs } : {}),
    ...(sandbox.readyTimeoutMs !== undefined ? { readyTimeoutMs: sandbox.readyTimeoutMs } : {}),
    ...(sandbox.readyPollMs !== undefined ? { readyPollMs: sandbox.readyPollMs } : {}),
    ...(sandbox.idleTimeoutMs !== undefined ? { idleTimeoutMs: sandbox.idleTimeoutMs } : {}),
    ...(sandbox.sandboxCacheTtlMs !== undefined ? { sandboxCacheTtlMs: sandbox.sandboxCacheTtlMs } : {}),
    ...(sandbox.startTimeoutMs !== undefined ? { startTimeoutMs: sandbox.startTimeoutMs } : {}),
    ...(sandbox.toolTimeoutMs !== undefined ? { transportTimeoutMs: sandbox.toolTimeoutMs } : {}),
    ...(sandbox.maxOutputBytes !== undefined ? { maxOutputBytes: sandbox.maxOutputBytes } : {}),
  }
}

/**
 * 挂载一行组合：停用的行不挂，覆盖里的 `enabled` 与 `config` 依次生效。
 * @param ctx - 组合上下文。
 * @param row - 组合清单里的一行。
 * @param config - 已校验的租户配置。
 * @returns 该行的 fiber；行停用时不挂，返回 `undefined`。
 */
async function mountSpineRow(ctx: Context, row: SpineRow, config: TenantAppConfig): Promise<Fiber | undefined> {
  const override = config.plugins?.[row.id]
  if (override?.enabled === true || (override?.enabled === undefined && row.disabled === undefined)) {
    return await mountModule(ctx, row.id, row.module, { ...row.config?.(config) ?? {}, ...override?.config ?? {} })
  }
  return undefined
}

/**
 * 按模块名装载并挂载一块插件；装载失败时指出是哪一行。
 * @returns 这一块的 fiber，供 {@link assertLoaded} 在启动末尾核对它是否真的加载成功。
 */
async function mountModule(ctx: Context, id: string, module: string, config: Record<string, unknown>): Promise<Fiber> {
  let loaded: unknown
  try {
    loaded = await import(module)
  } catch (error) {
    throw new Error(`组合行 ${id} 加载 ${module} 失败：${(error as Error).message}`)
  }
  const record = loaded as { default?: unknown }
  const plugin = (record.default ?? loaded) as Plugin
  return await mountLabeled(`组合行 ${id}（${module}）`, async () =>
    await ctx.plugin(plugin, Object.keys(config).length > 0 ? config : undefined))
}
