/**
 * 租户服务配置的读取与校验。
 *
 * 配置只有一个来源：一个 YAML/JSON 文件（`--config` 或 `DSH_TENANT_CONFIG`），加上一组
 * 覆盖它的环境变量。缺必填项、类型不对、给了互斥的两项、写了不存在的字段名，一律在启动前
 * 抛错——宁可起不来，也不要带着半个配置跑起来。
 * @module @deepseek-ai/dsh-tenant-app/config
 */

import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import type { TenantAppConfig } from './types.ts'

/** 配置文件路径的环境变量名；命令行 `--config` 优先于它。 */
export const CONFIG_PATH_ENV = 'DSH_TENANT_CONFIG'

/** 配置有误时抛出的错误；消息里指明是哪个字段、期望什么。 */
export class TenantAppConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantAppConfigError'
  }
}

/** 一段配置的取值器：把“缺了”与“给错了”讲清楚，并拒绝拼错的字段名。 */
class Reader {
  constructor(
    private readonly path: string,
    private readonly source: Record<string, unknown>,
  ) {}

  /** 子配置的取值器。 */
  child(key: string): Reader {
    const value = this.source[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TenantAppConfigError(`${this.full(key)} 必须是对象`)
    }
    return new Reader(this.full(key), value as Record<string, unknown>)
  }

  /** 可选的子配置；给了就按对象校验，没给返回 `undefined`。 */
  optionalChild(key: string): Reader | undefined {
    return this.source[key] === undefined ? undefined : this.child(key)
  }

  /** 必填的非空字符串。 */
  string(key: string): string {
    const value = this.source[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new TenantAppConfigError(`${this.full(key)} 必须是非空字符串`)
    }
    return value
  }

  /** 可选的非空字符串。 */
  optionalString(key: string): string | undefined {
    return this.source[key] === undefined ? undefined : this.string(key)
  }

  /** 必填的有限数字。 */
  number(key: string): number {
    const value = this.source[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TenantAppConfigError(`${this.full(key)} 必须是数字`)
    }
    return value
  }

  /** 可选的有限数字。 */
  optionalNumber(key: string): number | undefined {
    return this.source[key] === undefined ? undefined : this.number(key)
  }

  /** 可选的正整数；并发上限这类取值用它，`0` 与小数都在这里被拒。 */
  optionalPositiveInteger(key: string): number | undefined {
    if (this.source[key] === undefined) return undefined
    const value = this.number(key)
    if (!Number.isInteger(value) || value < 1) {
      throw new TenantAppConfigError(`${this.full(key)} 必须是正整数`)
    }
    return value
  }

  /** 可选的非负整数；`retryAttempts` 这类「零是有效取值」的项用它。 */
  optionalNonNegativeInteger(key: string): number | undefined {
    if (this.source[key] === undefined) return undefined
    const value = this.number(key)
    if (!Number.isInteger(value) || value < 0) {
      throw new TenantAppConfigError(`${this.full(key)} 必须是非负整数`)
    }
    return value
  }

  /** 可选的 0..1 比例（两端含）；`decreaseFactor` / `retryJitterRatio` 这类比例取值用它。 */
  optionalRatio(key: string): number | undefined {
    if (this.source[key] === undefined) return undefined
    const value = this.number(key)
    if (value < 0 || value > 1) {
      throw new TenantAppConfigError(`${this.full(key)} 必须是 0 到 1 之间的数字`)
    }
    return value
  }

  /** 必填的布尔。 */
  boolean(key: string): boolean {
    const value = this.source[key]
    if (typeof value !== 'boolean') throw new TenantAppConfigError(`${this.full(key)} 必须是布尔值`)
    return value
  }

  /** 可选的布尔。 */
  optionalBoolean(key: string): boolean | undefined {
    return this.source[key] === undefined ? undefined : this.boolean(key)
  }

  /** 必填的枚举值。 */
  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.string(key)
    if (!allowed.includes(value as T)) {
      throw new TenantAppConfigError(`${this.full(key)} 只能是 ${allowed.join(' / ')}，收到 ${value}`)
    }
    return value as T
  }

  /** 可选的枚举值。 */
  optionalOneOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    return this.source[key] === undefined ? undefined : this.oneOf(key, allowed)
  }

  /** 必填的字符串数组。 */
  stringArray(key: string): string[] {
    const value = this.source[key]
    if (!Array.isArray(value)) throw new TenantAppConfigError(`${this.full(key)} 必须是数组`)
    return value.map((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new TenantAppConfigError(`${this.full(key)}[${index}] 必须是非空字符串`)
      }
      return entry
    })
  }

  /** 可选的字符串数组。 */
  optionalStringArray(key: string): string[] | undefined {
    return this.source[key] === undefined ? undefined : this.stringArray(key)
  }

  /** 可选的字符串字典；`env` 这类环境变量表用它。 */
  optionalStringMap(key: string): Record<string, string> | undefined {
    const value = this.source[key]
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TenantAppConfigError(`${this.full(key)} 必须是对象`)
    }
    const map: Record<string, string> = {}
    for (const [name, entry] of Object.entries(value)) {
      if (typeof entry !== 'string') throw new TenantAppConfigError(`${this.full(key)}.${name} 必须是字符串`)
      map[name] = entry
    }
    return map
  }

  /** 配置里的全部字段名。 */
  keys(): string[] {
    return Object.keys(this.source)
  }

  /** 本层的原始内容，交给需要整体转交的字段（如逐行的插件配置）。 */
  raw(): Record<string, unknown> {
    return this.source
  }

  /** 必填的数组。 */
  array(key: string): unknown[] {
    const value = this.source[key]
    if (!Array.isArray(value)) throw new TenantAppConfigError(`${this.full(key)} 必须是数组`)
    return value
  }

  /** 字段的全名，用于诊断。 */
  full(key: string): string {
    return `${this.path}.${key}`
  }

  /**
   * 拒绝本层不认识的字段。拼错字段名必须响亮失败：静默忽略会让部署以为某项已生效，
   * 而实际跑的是默认值。
   */
  rejectUnknown(allowed: readonly string[]): void {
    const unknown = this.keys().filter(key => !allowed.includes(key))
    if (unknown.length > 0) {
      throw new TenantAppConfigError(`${this.path} 有未知字段：${unknown.join(', ')}；可用字段：${allowed.join(', ')}`)
    }
  }
}

/**
 * 读取并校验租户服务配置。
 * @param configPath - YAML 或 JSON 配置文件路径。
 * @param env - 覆盖配置的环境变量来源，默认 `process.env`。
 * @returns 校验通过的配置。
 * @throws `TenantAppConfigError` 文件读不到、解析失败或任一字段非法。
 */
export function loadTenantAppConfig(configPath: string, env: NodeJS.ProcessEnv = process.env): TenantAppConfig {
  const raw = parseConfig(configPath, readConfigFile(configPath))
  return validate(applyEnvOverrides(raw, env))
}

/** 读取配置文件；读不到就说清是哪个路径。 */
function readConfigFile(configPath: string): string {
  try {
    return readFileSync(configPath, 'utf8')
  } catch (error) {
    throw new TenantAppConfigError(`读不到配置文件 ${configPath}：${(error as Error).message}`)
  }
}

/** 解析 YAML/JSON：YAML 是 JSON 的超集，一个解析器够用。 */
function parseConfig(configPath: string, text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    throw new TenantAppConfigError(`配置文件 ${configPath} 解析失败：${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TenantAppConfigError(`配置文件 ${configPath} 的顶层必须是对象`)
  }
  return parsed as Record<string, unknown>
}

/**
 * 环境变量覆盖：只覆盖部署会变的那几个值，其余仍从文件读。
 *
 * 环境变量的优先级高于文件，因为容器化部署里同一份配置要跑多个环境；数字字段按
 * 原有类型转换，避免出现字符串端口。
 */
function applyEnvOverrides(config: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const merged = structuredClone(config)
  const set = (path: readonly string[], value: string | undefined): void => {
    if (value === undefined || value.length === 0) return
    let cursor = merged
    for (const key of path.slice(0, -1)) {
      const next = cursor[key]
      if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[key] = {}
      cursor = cursor[key] as Record<string, unknown>
    }
    const last = path.at(-1) as string
    cursor[last] = typeof cursor[last] === 'number' ? Number(value) : value
  }
  set(['http', 'host'], env.DSH_TENANT_HTTP_HOST)
  set(['http', 'port'], env.DSH_TENANT_HTTP_PORT)
  set(['database', 'connectionString'], env.DSH_TENANT_POSTGRES_URL)
  set(['auth', 'issuer'], env.DSH_TENANT_OIDC_ISSUER)
  set(['auth', 'audience'], env.DSH_TENANT_OIDC_AUDIENCE)
  set(['auth', 'verify', 'jwksUri'], env.DSH_TENANT_OIDC_JWKS_URI)
  set(['auth', 'verify', 'secret'], env.DSH_TENANT_OIDC_SECRET)
  set(['admin', 'scope'], env.DSH_TENANT_ADMIN_SCOPE)
  set(['tenants', 'usersRoot'], env.DSH_TENANT_USERS_ROOT)
  set(['tenants', 'archiveRoot'], env.DSH_TENANT_ARCHIVE_ROOT)
  set(['tenants', 'defaults', 'dataRoot'], env.DSH_TENANT_DATA_ROOT)
  set(['tenants', 'defaults', 'workspaceRoot'], env.DSH_TENANT_WORKSPACE_ROOT)
  set(['tenants', 'defaults', 'toolsRoot'], env.DSH_TENANT_TOOLS_ROOT)
  set(['sandbox', 'backend'], env.DSH_TENANT_SANDBOX_BACKEND)
  set(['sandbox', 'namespace'], env.DSH_TENANT_K8S_NAMESPACE)
  set(['sandbox', 'image'], env.DSH_TENANT_SANDBOX_IMAGE)
  set(['sandbox', 'runtime'], env.DSH_TENANT_DOCKER_RUNTIME)
  set(['sandbox', 'network'], env.DSH_TENANT_DOCKER_NETWORK)
  set(['sandbox', 'systemRoot'], env.DSH_TENANT_SYSTEM_ROOT)
  set(['sandbox', 'pythonRoot'], env.DSH_TENANT_PYTHON_ROOT)
  set(['sandbox', 'toolsRoot'], env.DSH_TENANT_TOOLS_ROOT)
  set(['sandbox', 'workspaceClaim'], env.DSH_TENANT_WORKSPACE_CLAIM)
  set(['sandbox', 'claimRoot'], env.DSH_TENANT_CLAIM_ROOT)
  return merged
}

/** 逐字段校验：这一层是配置边界，每个值都要真检查，并给出中文诊断。 */
function validate(config: Record<string, unknown>): TenantAppConfig {
  const root = new Reader('配置', config)
  root.rejectUnknown([
    'http', 'database', 'auth', 'admin', 'tenants', 'sandbox',
    'permissions', 'model', 'web', 'telemetry', 'surfaces', 'tools', 'plugins', 'mcpServers', 'mcpMeta',
  ])

  const http = readHttp(root.child('http'))
  const database = { connectionString: root.child('database').string('connectionString') }
  const auth = readAuth(root.child('auth'))
  const admin = { scope: root.child('admin').string('scope') }
  const tenants = readTenants(root.child('tenants'))
  const sandbox = readSandbox(root.child('sandbox'))
  const permissions = readPermissions(root.optionalChild('permissions'))
  const model = readModel(root.optionalChild('model'))
  const web = readWeb(root.optionalChild('web'))
  const telemetry = readTelemetry(root.optionalChild('telemetry'))
  const surfaces = readSurfaces(root.optionalChild('surfaces'))
  const tools = readTools(root.optionalChild('tools'))
  const plugins = readPlugins(root.optionalChild('plugins'))
  const mcpServers = readMcpServers(root)
  const mcpMeta = readMcpMeta(root)

  return {
    http,
    database,
    auth,
    admin,
    tenants,
    sandbox,
    ...(permissions !== undefined ? { permissions } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(web !== undefined ? { web } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(surfaces !== undefined ? { surfaces } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(plugins !== undefined ? { plugins } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(mcpMeta !== undefined ? { mcpMeta } : {}),
  }
}

/**
 * 入站请求头到 MCP `_meta` 的映射。
 *
 * 没配 `mcpMeta` 就返回 `undefined`，那条通道整块不挂：`mcp-client` 读不到提供者，
 * 每次调用不带 `_meta`，与加这条通道之前完全一致。
 * @param reader - 配置根。
 * @returns 已校验的映射；未配置时为 `undefined`。
 */
function readMcpMeta(reader: Reader): TenantAppConfig['mcpMeta'] {
  if (!reader.keys().includes('mcpMeta')) return undefined
  const meta = reader.child('mcpMeta')
  meta.rejectUnknown(['fromHeaders'])
  return { ...present('fromHeaders', meta.optionalStringMap('fromHeaders')) }
}

function readHttp(reader: Reader): TenantAppConfig['http'] {
  reader.rejectUnknown(['host', 'port'])
  return { host: reader.oneOf('host', ['127.0.0.1', '0.0.0.0'] as const), port: reader.number('port') }
}

function readAuth(reader: Reader): TenantAppConfig['auth'] {
  reader.rejectUnknown(['issuer', 'verify', 'audience', 'tenantIdClaim', 'clockToleranceSeconds'])
  const verifyReader = reader.child('verify')
  const kind = verifyReader.oneOf('kind', ['jwks', 'secret'] as const)
  const verify = kind === 'jwks'
    ? { kind, jwksUri: verifyReader.string('jwksUri') } as const
    : { kind, secret: verifyReader.string('secret') } as const
  verifyReader.rejectUnknown(kind === 'jwks' ? ['kind', 'jwksUri'] : ['kind', 'secret'])
  const audience = reader.optionalString('audience')
  const tenantIdClaim = reader.optionalString('tenantIdClaim')
  const clockToleranceSeconds = reader.optionalNumber('clockToleranceSeconds')
  return {
    issuer: reader.string('issuer'),
    verify,
    ...(audience !== undefined ? { audience } : {}),
    ...(tenantIdClaim !== undefined ? { tenantIdClaim } : {}),
    ...(clockToleranceSeconds !== undefined ? { clockToleranceSeconds } : {}),
  }
}

function readTenants(reader: Reader): TenantAppConfig['tenants'] {
  reader.rejectUnknown(['usersRoot', 'archiveRoot', 'defaults'])
  const defaults = reader.child('defaults')
  defaults.rejectUnknown(['dataRoot', 'workspaceRoot', 'toolsRoot', 'network'])
  const toolsRoot = defaults.optionalString('toolsRoot')
  return {
    usersRoot: reader.string('usersRoot'),
    archiveRoot: reader.string('archiveRoot'),
    defaults: {
      dataRoot: defaults.string('dataRoot'),
      workspaceRoot: defaults.string('workspaceRoot'),
      ...(toolsRoot !== undefined ? { toolsRoot } : {}),
      network: defaults.oneOf('network', ['none', 'internal'] as const),
    },
  }
}

function readSandbox(reader: Reader): TenantAppConfig['sandbox'] {
  const backend = reader.oneOf('backend', ['docker', 'k8s'] as const)
  const shared = ['workDir', 'caseReadOnly', 'usersReadOnly', 'systemRoot', 'pythonRoot', 'toolsRoot', 'idleTimeoutMs', 'sandboxCacheTtlMs', 'startTimeoutMs', 'toolTimeoutMs', 'maxOutputBytes']
  if (backend === 'docker') {
    reader.rejectUnknown([
      'backend', ...shared,
      'runtime', 'network', 'image', 'toolExecPort', 'publishHost', 'connectHost', 'imagePath', 'memoryLimit', 'cpuLimit',
      'cliTimeoutMs', 'readyTimeoutMs', 'readyPollMs',
    ])
    return {
      backend,
      ...commonSandbox(reader),
      ...present('runtime', reader.optionalOneOf('runtime', ['docker', 'podman'] as const)),
      ...present('network', reader.optionalString('network')),
      ...present('image', reader.optionalString('image')),
      ...present('toolExecPort', reader.optionalNumber('toolExecPort')),
      ...present('publishHost', reader.optionalString('publishHost')),
      ...present('connectHost', reader.optionalString('connectHost')),
      ...present('imagePath', reader.optionalString('imagePath')),
      ...present('memoryLimit', reader.optionalString('memoryLimit')),
      ...present('cpuLimit', reader.optionalNumber('cpuLimit')),
      ...present('cliTimeoutMs', reader.optionalNumber('cliTimeoutMs')),
      ...present('readyTimeoutMs', reader.optionalNumber('readyTimeoutMs')),
      ...present('readyPollMs', reader.optionalNumber('readyPollMs')),
    }
  }
  reader.rejectUnknown([
    'backend', ...shared,
    'namespace', 'image', 'kubectlBinary', 'imagePullPolicy', 'toolExecPort', 'imagePath',
    'workspaceClaim', 'claimRoot', 'systemRoot', 'pythonRoot', 'toolsRoot', 'pythonEnv',
    'memoryLimit', 'cpuLimit',
    'cliTimeoutMs', 'statusPollMs', 'readyTimeoutMs', 'readyPollMs', 'command', 'env',
  ])
  return {
    backend,
    ...commonSandbox(reader),
    namespace: reader.string('namespace'),
    image: reader.string('image'),
    ...present('kubectlBinary', reader.optionalString('kubectlBinary')),
    ...present('imagePullPolicy', reader.optionalString('imagePullPolicy')),
    ...present('toolExecPort', reader.optionalNumber('toolExecPort')),
    workspaceClaim: reader.string('workspaceClaim'),
    claimRoot: reader.string('claimRoot'),
    systemRoot: reader.string('systemRoot'),
    pythonRoot: reader.string('pythonRoot'),
    toolsRoot: reader.string('toolsRoot'),
    pythonEnv: readPythonEnv(reader.child('pythonEnv')),
    ...present('command', reader.optionalStringArray('command')),
    ...present('env', reader.optionalStringMap('env')),
    ...present('imagePath', reader.optionalString('imagePath')),
    ...present('memoryLimit', reader.optionalString('memoryLimit')),
    ...present('cpuLimit', reader.optionalNumber('cpuLimit')),
    ...present('cliTimeoutMs', reader.optionalNumber('cliTimeoutMs')),
    ...present('statusPollMs', reader.optionalNumber('statusPollMs')),
    ...present('readyTimeoutMs', reader.optionalNumber('readyTimeoutMs')),
    ...present('readyPollMs', reader.optionalNumber('readyPollMs')),
  }
}

/** 沙箱内 Python 的三条路径：节点目录宿主读不到，所以逐项由配置给出。 */
function readPythonEnv(reader: Reader): { binDir: string; virtualEnv: string; sitePackages: string } {
  reader.rejectUnknown(['binDir', 'virtualEnv', 'sitePackages'])
  return {
    binDir: reader.string('binDir'),
    virtualEnv: reader.string('virtualEnv'),
    sitePackages: reader.string('sitePackages'),
  }
}

/** 两个后端共有的分层挂载与生命周期字段。 */
function commonSandbox(reader: Reader): Record<string, unknown> {
  return {
    ...present('workDir', reader.optionalString('workDir')),
    ...present('caseReadOnly', reader.optionalBoolean('caseReadOnly')),
    ...present('usersReadOnly', reader.optionalBoolean('usersReadOnly')),
    ...present('systemRoot', reader.optionalString('systemRoot')),
    ...present('pythonRoot', reader.optionalString('pythonRoot')),
    ...present('toolsRoot', reader.optionalString('toolsRoot')),
    ...present('idleTimeoutMs', reader.optionalNumber('idleTimeoutMs')),
    ...present('sandboxCacheTtlMs', reader.optionalNumber('sandboxCacheTtlMs')),
    ...present('startTimeoutMs', reader.optionalNumber('startTimeoutMs')),
    ...present('toolTimeoutMs', reader.optionalNumber('toolTimeoutMs')),
    ...present('maxOutputBytes', reader.optionalNumber('maxOutputBytes')),
  }
}

/** 把“读到就带上”写成一处，省掉每个可选字段的三目。 */
function present<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

function readPermissions(reader: Reader | undefined): TenantAppConfig['permissions'] {
  if (reader === undefined) return undefined
  reader.rejectUnknown(['mode', 'approval'])
  const mode = reader.oneOf('mode', ['read-only', 'workspace-write', 'danger-full-access'] as const)
  const approval = reader.optionalOneOf('approval', ['never', 'ask'] as const)
  return { mode, ...(approval !== undefined ? { approval } : {}) }
}

function readModel(reader: Reader | undefined): TenantAppConfig['model'] {
  if (reader === undefined) return undefined
  reader.rejectUnknown(['provider', 'model'])
  return { provider: reader.string('provider'), model: reader.string('model') }
}

function readWeb(reader: Reader | undefined): TenantAppConfig['web'] {
  if (reader === undefined) return undefined
  reader.rejectUnknown(['searchApiKeyEnv'])
  return { searchApiKeyEnv: reader.string('searchApiKeyEnv') }
}

function readTelemetry(reader: Reader | undefined): TenantAppConfig['telemetry'] {
  if (reader === undefined) return undefined
  reader.rejectUnknown(['mode', 'url'])
  const mode = reader.oneOf('mode', ['DISABLED', 'OTLP'] as const)
  const url = reader.optionalString('url')
  if (mode === 'OTLP' && url === undefined) {
    throw new TenantAppConfigError('配置.telemetry.url 在 mode: OTLP 时必填')
  }
  return { mode, ...(url !== undefined ? { url } : {}) }
}

function readSurfaces(reader: Reader | undefined): TenantAppConfig['surfaces'] {
  if (reader === undefined) return undefined
  reader.rejectUnknown(['openapi', 'console', 'adminOpenapi'])
  return {
    ...present('openapi', reader.optionalBoolean('openapi')),
    ...present('console', reader.optionalBoolean('console')),
    ...present('adminOpenapi', reader.optionalBoolean('adminOpenapi')),
  }
}

/**
 * 工具呈现与并发。两项都可省：省下的那一项由组合清单的 `tools` 行补上租户栈的默认值
 * （`code` 与 32 路），缺省值不在这里出现，免得同一件事有两个地方能改。
 */
function readTools(reader: Reader | undefined): TenantAppConfig['tools'] {
  if (reader === undefined) return undefined
  reader.rejectUnknown(['mode', 'maxParallelSubCalls'])
  return {
    ...present('mode', reader.optionalOneOf('mode', ['native', 'code', 'both'] as const)),
    ...present('maxParallelSubCalls', reader.optionalPositiveInteger('maxParallelSubCalls')),
  }
}

function readPlugins(reader: Reader | undefined): TenantAppConfig['plugins'] {
  if (reader === undefined) return undefined
  const overrides: Record<string, { enabled?: boolean; config?: Readonly<Record<string, unknown>> }> = {}
  for (const id of reader.keys()) {
    const row = reader.child(id)
    row.rejectUnknown(['enabled', 'config'])
    const enabled = row.optionalBoolean('enabled')
    const config = row.optionalChild('config')
    overrides[id] = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(config !== undefined ? { config: config.raw() } : {}),
    }
  }
  return overrides
}

function readMcpServers(reader: Reader): TenantAppConfig['mcpServers'] {
  if (!reader.keys().includes('mcpServers')) return undefined
  return reader.array('mcpServers').map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TenantAppConfigError(`配置.mcpServers[${index}] 必须是对象`)
    }
    const row = new Reader(`配置.mcpServers[${index}]`, entry as Record<string, unknown>)
    // 照 `mcp-client` 的 HTTP 分支抄，一行一个键：`reconnect` 不在这里，因为当前没有用到它的场景，
    // 未透传的字段按客户端自己的默认值生效（`reconnect` 省略即用它的默认策略）。
    row.rejectUnknown(['serverName', 'transport', 'url', 'headers', 'toolConcurrency', 'toolCallTimeoutMs', 'failOnStartupError'])
    return {
      serverName: row.string('serverName'),
      // 只放开 mcp-client 真正有的那一支：它的 Config 是 stdio / streamable-http 的判别联合，
      // 没有 sse。接受一个它不认的取值，那一行要到挂载时才失败，而配置校验本该在这里说清。
      transport: row.oneOf('transport', ['streamable-http'] as const),
      url: row.string('url'),
      ...present('headers', row.optionalStringMap('headers')),
      ...present('toolConcurrency', readToolConcurrency(row.optionalChild('toolConcurrency'))),
      ...present('toolCallTimeoutMs', row.optionalPositiveInteger('toolCallTimeoutMs')),
      ...present('failOnStartupError', row.optionalBoolean('failOnStartupError')),
    }
  })
}

/**
 * 一条 MCP 服务器的工具调用并发。字段与 `@deepseek-ai/dsh-mcp-client` 的 `ToolConcurrency`
 * 同名同义：租户栈只按原名转发并校验，语义与默认值都由 MCP 客户端持有，省下的项由它补。
 *
 * 这份列表照客户端的 schema 抄，一行一个键：它新增字段时在这里加一行，并在下面的返回值里加一行
 * 取值校验——两处相邻，漏一处会让那个字段以未知字段的身份响亮失败，而不是静默忽略。
 *
 * 校验只覆盖类型与取值域（枚举、正整数、非负整数、0..1 比例、布尔、名字数组）。更细的边界
 * （`decreaseFactor` 必须严格落在 0 与 1 之间、`retryAttempts` 最多 5、两个定时器的上界）由客户端
 * 自己的 resolve 步骤判定——那是它的契约，抄到这里就成了第二份边界，两边迟早漂移。越界的取值仍然
 * 响亮：它在挂载那一行时报错并指名这一行，消息来自契约的持有者。
 */
const TOOL_CONCURRENCY_FIELDS = [
  'policy',
  'maxConcurrentCalls',
  'exclusiveTools',
  'retryTools',
  'mode',
  'decreaseFactor',
  'recoveryStep',
  'recoveryQuietMs',
  'countTimeouts',
  'retryAttempts',
  'retryBaseDelayMs',
  'retryJitterRatio',
] as const

function readToolConcurrency(reader: Reader | undefined): NonNullable<TenantAppConfig['mcpServers']>[number]['toolConcurrency'] {
  if (reader === undefined) return undefined
  reader.rejectUnknown(TOOL_CONCURRENCY_FIELDS)
  return {
    ...present('policy', reader.optionalOneOf('policy', ['annotations', 'parallel', 'exclusive'] as const)),
    ...present('maxConcurrentCalls', reader.optionalPositiveInteger('maxConcurrentCalls')),
    // 第三方 server 的注解不可信时，写数据的工具靠这份名单保持串行；名字是该 server 报出的原名。
    // 它只管提交顺序，与重发无关——能不能重发由下面的 `retryTools` 回答。
    ...present('exclusiveTools', reader.optionalStringArray('exclusiveTools')),
    // 被拒后允许重发的原名，在工具自己声明 `readOnlyHint: true` 的那些之外。不写（或写成空名单）
    // 就只剩只读工具会重发：写工具重发与否是部署的判断，客户端不替它猜。
    ...present('retryTools', reader.optionalStringArray('retryTools')),
    ...present('mode', reader.optionalOneOf('mode', ['fixed', 'adaptive'] as const)),
    ...present('decreaseFactor', reader.optionalRatio('decreaseFactor')),
    ...present('recoveryStep', reader.optionalPositiveInteger('recoveryStep')),
    ...present('recoveryQuietMs', reader.optionalPositiveInteger('recoveryQuietMs')),
    ...present('countTimeouts', reader.optionalBoolean('countTimeouts')),
    ...present('retryAttempts', reader.optionalNonNegativeInteger('retryAttempts')),
    ...present('retryBaseDelayMs', reader.optionalPositiveInteger('retryBaseDelayMs')),
    ...present('retryJitterRatio', reader.optionalRatio('retryJitterRatio')),
  }
}
