/**
 * 租户服务的组合测试。
 *
 * 第一条断言配置边界：缺项、错项、拼错的字段名都必须响亮失败。
 * 第二条是真实组合：用一份测试配置启动 `createTenantApp`，只挂租户层、HTTP 载体与执行层
 * （组合清单里的 dsh 核心行按配置逐行停用），然后从**真实监听端口**上验证两个面各自的准入
 * ——不经过 Loader、不经过 dsh 的 bundle，也没有任何 dsh 的 cordis.yml 参与。
 * 第三条看清单推导出的取值：工具呈现方式、并发上限与沙箱字段是否真的到达挂载的插件。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TenantId, UserId, runWithTenant, runWithUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { TenantAppConfigError, loadTenantAppConfig } from '../src/config.ts'
import { SPINE } from '../src/spine.ts'
import type { TenantApp, TenantAppConfig } from '../src/types.ts'

/** 写一份临时配置文件并读回来，顺带覆盖真正的文件加载路径。 */
function configFrom(body: string, env: NodeJS.ProcessEnv = {}): TenantAppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tenant-app-'))
  const path = join(dir, 'tenant.config.yaml')
  writeFileSync(path, body)
  tempDirs.push(dir)
  return loadTenantAppConfig(path, env)
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

/** 一份最小可用配置：数据库指向一个不会真的被连接的本机端口，沙箱是本地 docker。 */
const MINIMAL = `
http:
  host: 127.0.0.1
  port: 0
database:
  connectionString: postgres://127.0.0.1:1/none
auth:
  issuer: https://issuer.example
  verify:
    kind: secret
    secret: test-secret
admin:
  scope: dsh:tenant-admin
tenants:
  usersRoot: /srv/users
  archiveRoot: /srv/archive
  defaults:
    dataRoot: /srv/data
    workspaceRoot: /srv/workspace
    network: none
sandbox:
  backend: docker
`

/** k8s 形态的最小配置：分层目录、Python 三件套与 claim 都是 k8s 后端的必填项。 */
const K8S_MINIMAL = `${MINIMAL}  workspaceClaim: sandbox-claim
  claimRoot: /srv/claim
  systemRoot: /srv/system
  pythonRoot: /srv/python
  toolsRoot: /srv/tools
  pythonEnv:
    binDir: /usr/local/bin
    virtualEnv: /opt/venv
    sitePackages: /opt/venv/lib/python3.12/site-packages
`.replace('  backend: docker\n', '  backend: k8s\n  namespace: from-file\n  image: registry.example/sandbox:file\n')

/** 把组合清单里的每一行都停用：组合测试只验证租户层与 HTTP 层的装配。 */
function spineDisabled(): NonNullable<TenantAppConfig['plugins']> {
  return Object.fromEntries(SPINE.map(row => [row.id, { enabled: false }]))
}

/**
 * 组合里某一块插件实际收到的配置。
 *
 * `ctx.registry` 每一项是一块插件与它的全部实例，实例的 `config` 是校验后的取值，所以读到的是
 * 「清单推导 + 配置覆盖 + 插件 schema 默认值」之后真正交给插件的那份，而不是某个推导函数的返回值。
 * 名字取自插件本身：清单按模块名装载，函数插件用它导出的 `name`（`mcp-client`），
 * 类插件用类名（`dsh-tools` 的默认导出是 `ToolRuntime`，容器运行时是它自己的类名）。
 */
function mountedConfigs(app: TenantApp, name: string): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = []
  app.ctx.registry.forEach((runtime) => {
    if (runtime.name !== name) return
    for (const fiber of runtime.fibers) configs.push(fiber.config as Record<string, unknown>)
  })
  return configs
}

/** 只挂工具那两行：`tools` 要 `system-prompt` 提供服务，其余清单行停用后不需要 Postgres 与沙箱。 */
async function bootTools(config: TenantAppConfig): Promise<TenantApp> {
  const { createTenantApp } = await import('../src/compose.ts')
  return await createTenantApp({
    ...config,
    plugins: { ...spineDisabled(), 'system-prompt': { enabled: true }, tools: { enabled: true } },
  })
}

describe('租户服务配置', () => {
  it('缺少必填小节时报出中文诊断', () => {
    expect(() => configFrom('http:\n  host: 127.0.0.1\n  port: 0\n'))
      .toThrow(TenantAppConfigError)
  })

  it('拒绝拼错的字段名而不是静默忽略', () => {
    expect(() => configFrom(`${MINIMAL}\nwat: 1\n`)).toThrow(/未知字段/)
  })

  it('auth.verify 只接受两种校验方式之一', () => {
    expect(() => configFrom(MINIMAL.replace('kind: secret\n    secret: test-secret', 'kind: mtls')))
      .toThrow(/只能是 jwks \/ secret/)
  })

  it('telemetry 走 OTLP 时必须给端点', () => {
    expect(() => configFrom(`${MINIMAL}\ntelemetry:\n  mode: OTLP\n`)).toThrow(/telemetry.url/)
  })

  it('k8s 后端必须给出命名空间与镜像', () => {
    expect(() => configFrom(MINIMAL.replace('backend: docker', 'backend: k8s')))
      .toThrow(/配置\.sandbox\.namespace/)
  })

  it('k8s 后端缺少 pythonEnv 时报出中文诊断', () => {
    const withoutPythonEnv = K8S_MINIMAL.replace(/ {2}pythonEnv:\n(?: {4}\w+: [^\n]+\n)+/, '')
    expect(() => configFrom(withoutPythonEnv)).toThrow(/配置\.sandbox\.pythonEnv/)
  })

  it('k8s 后端拒绝只属于 docker 的资源上限字段', () => {
    expect(() => configFrom(`${K8S_MINIMAL}  memoryLimit: 2Gi\n`)).toThrow(/未知字段/)
  })

  it('环境变量覆盖文件里的取值', () => {
    const config = configFrom(K8S_MINIMAL, {
      DSH_TENANT_HTTP_PORT: '8123',
      DSH_TENANT_SANDBOX_IMAGE: 'registry.example/sandbox:1',
      DSH_TENANT_K8S_NAMESPACE: 'tenant-sandboxes',
      DSH_TENANT_WORKSPACE_CLAIM: 'sandbox-claim-2',
    })
    expect(config.http.port).toBe(8123)
    expect(config.sandbox).toMatchObject({
      backend: 'k8s',
      namespace: 'tenant-sandboxes',
      image: 'registry.example/sandbox:1',
      workspaceClaim: 'sandbox-claim-2',
    })
  })

  it('tools.mode 只接受三种呈现方式', () => {
    expect(() => configFrom(`${MINIMAL}tools:\n  mode: native-plus\n`))
      .toThrow(/配置\.tools\.mode 只能是 native \/ code \/ both/)
  })

  it('tools.maxParallelSubCalls 必须是正整数', () => {
    expect(() => configFrom(`${MINIMAL}tools:\n  maxParallelSubCalls: 0\n`))
      .toThrow(/配置\.tools\.maxParallelSubCalls 必须是正整数/)
    expect(() => configFrom(`${MINIMAL}tools:\n  maxParallelSubCalls: 1.5\n`))
      .toThrow(/配置\.tools\.maxParallelSubCalls 必须是正整数/)
  })

  it('沙箱段接受两个 provider 已有的可配置字段', () => {
    const docker = configFrom(`${MINIMAL}  maxOutputBytes: 134217728\n  cliTimeoutMs: 30000\n  readyTimeoutMs: 20000\n  readyPollMs: 50\n`)
    expect(docker.sandbox).toMatchObject({
      maxOutputBytes: 134217728,
      cliTimeoutMs: 30000,
      readyTimeoutMs: 20000,
      readyPollMs: 50,
    })
    const k8s = configFrom(`${K8S_MINIMAL}  command: [node, entry.mjs, '8642']\n  env:\n    NODE_OPTIONS: --max-old-space-size=1024\n`)
    expect(k8s.sandbox).toMatchObject({
      command: ['node', 'entry.mjs', '8642'],
      env: { NODE_OPTIONS: '--max-old-space-size=1024' },
    })
  })

  it('每条 MCP server 的工具并发只接受规定的字段与取值', () => {
    expect(() => configFrom(`${MINIMAL}mcpServers:\n  - serverName: mining\n    transport: streamable-http\n    url: http://127.0.0.1:1/mcp\n    toolConcurrency:\n      maxConcurrentCalls: 0\n`))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.maxConcurrentCalls 必须是正整数/)
    expect(() => configFrom(`${MINIMAL}mcpServers:\n  - serverName: mining\n    transport: streamable-http\n    url: http://127.0.0.1:1/mcp\n    toolConcurrency:\n      policy: always\n`))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.policy 只能是 annotations \/ parallel \/ exclusive/)
    expect(() => configFrom(`${MINIMAL}mcpServers:\n  - serverName: mining\n    transport: streamable-http\n    url: http://127.0.0.1:1/mcp\n    toolConcurrency:\n      maxConcurrent: 4\n`))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency 有未知字段：maxConcurrent/)
  })
})

/**
 * 文件里每个真启服务的组都用这个上限，不启服务的配置组保持 vitest 默认的五秒。
 *
 * 用例自己只做一次启动（`createTenantApp` 建 Context、挂行、收口量到 0.1–0.5 秒，`dispose` 约 10 毫秒，
 * 路径上没有任何定时器或重试），但从每个 fork 出来的 worker 第一次加载组合模块要付一次现转：
 * `import('../src/compose.ts')` 的依赖图单跑量到 3.5–8.6 秒，二十个文件同机并发时量到 9.2 秒。这份开销
 * 记在**该文件里第一个启服务的用例**头上，与是哪个用例无关：换文件顺序，或用 `-t` 只跑另一组，超时的
 * 就是另一个用例。所以上限给的是「真启服务的组」这个集合，而不是某一个用例；三十秒是实测最坏值的
 * 三倍，够负载再重一档。
 */
const BOOT_TIMEOUT_MS = 30_000

describe('租户工具限制行', () => {
  /** 一层层级目录：`tools-tier` 的根目录与限制读取器读的是同一批路径。 */
  function tierDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tenant-restriction-'))
    tempDirs.push(dir)
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    return path
  }

  /** 只挂层级 provider、限制读取器与它们依赖的工具运行时；其余清单行停用。 */
  async function bootRestriction(
    systemToolsDir: string,
    usersRoot: string,
    restrictionConfig?: Record<string, unknown>,
  ): Promise<TenantApp> {
    const { createTenantApp } = await import('../src/compose.ts')
    return await createTenantApp({
      ...configFrom(MINIMAL),
      plugins: {
        ...spineDisabled(),
        'system-prompt': { enabled: true },
        tools: { enabled: true },
        'tools-tier': { enabled: true, config: { usersRoot, systemToolsDir } },
        'tools-restriction': { enabled: true, ...(restrictionConfig !== undefined ? { config: restrictionConfig } : {}) },
      },
    })
  }

  it('层级目录没有限制文档时，行照样挂上且不收紧任何工具', async () => {
    const system = tierDir('system')
    const app = await bootRestriction(system, join(system, '..', 'users'))
    try {
      expect(mountedConfigs(app, 'tools-restriction')).toEqual([{}])
      expect(app.ctx.get('toolTiers')?.roots().map(root => root.path)).toContain(system)
    } finally {
      await app.dispose()
    }
  })

  it('已启用行的插件被推迟执行时，它失败会让组合启动失败并指名该行', async () => {
    // 这条断言的场景是真的：提供 `tools` 的组合行排在限制行**之后**，所以限制行的 `apply` 要等那一行
    // 挂上才执行——那时 `ctx.plugin()` 早已返回。限制行静默失败等于 160 个工具全部对模型可见，
    // 所以这种失败必须把启动打挂。先钉住前提，再钉住失败被报出来。
    const restriction = SPINE.findIndex(row => row.id === 'tools-restriction')
    expect(restriction).toBeGreaterThanOrEqual(0)
    expect(restriction).toBeLessThan(SPINE.findIndex(row => row.id === 'tools'))

    const system = tierDir('system')
    await expect(bootRestriction(system, join(system, '..', 'users'), { bogus: 1 })).rejects.toThrow(
      /组合行 tools-restriction（@deepseek-ai\/dsh-tools-restriction）（注入满足后才执行）启动失败：tools-restriction: unknown config key "bogus"/,
    )
  })

  it('系统层限制文档不合法时，组合启动失败并指出那份文档与那一行', async () => {
    const system = tierDir('system')
    writeFileSync(join(system, 'restriction.yaml'), 'allow: 3\n')
    const failure = await bootRestriction(system, join(system, '..', 'users'))
      .then(() => undefined, (error: unknown) => error)
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toMatch(/组合行 tools-restriction（@deepseek-ai\/dsh-tools-restriction）/)
    expect(message).toMatch(/restriction\.yaml: `allow` must be a list of non-empty tool names/)
  })

  it('正常启动的每一行都不误报启动失败', async () => {
    const system = tierDir('system')
    const app = await bootRestriction(system, join(system, '..', 'users'))
    try {
      expect(mountedConfigs(app, 'tools-restriction')).toHaveLength(1)
      expect(app.ctx.get('tools')).toBeDefined()
    } finally {
      await app.dispose()
    }
  })
}, BOOT_TIMEOUT_MS)

describe('租户服务的真实组合', () => {
  // 组合图按需加载：配置这一半不依赖沙箱后端的实现，测试也就不该被它拖下水。
  const boot = async (): Promise<TenantApp> => {
    const { createTenantApp } = await import('../src/compose.ts')
    // 停用全部清单行：这样起服务不需要 Postgres、不需要沙箱，探针量到的准入结论
    // 也就只可能来自这个组合本身，而不是某一行基础设施的副作用。
    return await createTenantApp({ ...configFrom(MINIMAL), plugins: spineDisabled() })
  }

  it('不依赖 dsh 的 bundle 与 Loader 就能起服务，并让两个面各自准入', async () => {
    const app = await boot()
    try {
      expect(app.port).toBeGreaterThan(0)
      const base = `http://127.0.0.1:${app.port}`

      const openapi = await fetch(`${base}/admin/openapi.json`)
      expect(openapi.status).toBe(200)
      const document = await openapi.json() as { paths: Record<string, unknown> }
      expect(Object.keys(document.paths)).toContain('/admin/tenants.list')

      const admin = await fetch(`${base}/admin/tenants.list`, { method: 'POST', body: '{}' })
      const adminBody = await admin.json() as { ok: boolean; error?: { code: string } }
      expect(admin.status).toBe(401)
      expect(adminBody).toMatchObject({ ok: false, error: { code: expect.any(String) } })

      // 业务面载体把 apiProxy 声明为注入，网关行停用后它根本不挂载，所以 /api 是 404：
      // 组合里不存在一条不校验权威的业务路由。业务面自己拒绝无凭据请求（401
      // MISSING_CREDENTIAL）由载体的真实 HTTP 测试覆盖：
      // packages/tenant/agent-http/tests/agent-http.spec.ts。
      const business = await fetch(`${base}/api/session.create`, { method: 'POST', body: '{}' })
      expect(business.status).toBe(404)

      // 方法名不是秘密——`/admin/openapi.json` 本来就公布全部方法——所以未知方法
      // 没有可准入的操作时报 404，而已知方法在无凭据时一律 401（见上一条断言）。
      const unknown = await fetch(`${base}/admin/tenants.nope`, { method: 'POST', body: '{}' })
      expect(unknown.status).toBe(404)
    } finally {
      await app.dispose()
    }
  })

  it('缺少凭据时管理面不落任何租户副作用', async () => {
    const app = await boot()
    try {
      const response = await fetch(`http://127.0.0.1:${app.port}/admin/tenants.create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'acme' }),
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ ok: false })
    } finally {
      await app.dispose()
    }
  })
}, BOOT_TIMEOUT_MS)

describe('工具呈现与并发上限', () => {
  it('未配置时按租户栈的默认值挂载：both 模式与 32 路并发', async () => {
    const app = await bootTools(configFrom(MINIMAL))
    try {
      expect(mountedConfigs(app, 'ToolRuntime')).toEqual([{ mode: 'both', maxParallelSubCalls: 32 }])
    } finally {
      await app.dispose()
    }
  })

  it('配置能改呈现方式与并发上限', async () => {
    const app = await bootTools(configFrom(`${MINIMAL}tools:
  mode: code
  maxParallelSubCalls: 64
`))
    try {
      expect(mountedConfigs(app, 'ToolRuntime')).toEqual([{ mode: 'code', maxParallelSubCalls: 64 }])
    } finally {
      await app.dispose()
    }
  })

  it('按原名透传每条 MCP server 的并发、超时与请求头', async () => {
    // 第一行是两份部署示例（docker/tenant.config.example.yaml、docker/k8s/tenant-host.yaml）
    // 逐条写明的组合：第三方 server 的注解不可信，所以由我们声明 parallel、让它起步串行，
    // 并把写数据的工具放进 exclusiveTools；认证走 headers（mcp-client 把它作为 requestInit.headers）。
    const app = await bootTools(configFrom(`${MINIMAL}mcpServers:
  - serverName: mining
    transport: streamable-http
    url: http://127.0.0.1:1/mcp
    headers:
      Authorization: Bearer local-dev
    toolCallTimeoutMs: 120000
    toolConcurrency:
      policy: parallel
      maxConcurrentCalls: 4
      exclusiveTools: [write_rows]
      retryTools: [read_rows]
      mode: fixed
      decreaseFactor: 0.25
      recoveryStep: 3
      recoveryQuietMs: 1500
      countTimeouts: false
      retryAttempts: 2
      retryBaseDelayMs: 100
      retryJitterRatio: 0.5
  - serverName: uncapped
    transport: streamable-http
    url: http://127.0.0.1:1/mcp
`))
    try {
      const servers = mountedConfigs(app, 'mcp-client')
      expect(servers).toHaveLength(2)
      // `toolConcurrency` 的十二个键逐一按原名到达客户端实例：顺序与重发是两件事，所以
      // `exclusiveTools` 与 `retryTools` 各走各的，自适应与重试的旋钮一个都不少。
      expect(servers[0]).toMatchObject({
        serverName: 'mining',
        headers: { Authorization: 'Bearer local-dev' },
        toolCallTimeoutMs: 120000,
        toolConcurrency: {
          policy: 'parallel',
          maxConcurrentCalls: 4,
          exclusiveTools: ['write_rows'],
          retryTools: ['read_rows'],
          mode: 'fixed',
          decreaseFactor: 0.25,
          recoveryStep: 3,
          recoveryQuietMs: 1500,
          countTimeouts: false,
          retryAttempts: 2,
          retryBaseDelayMs: 100,
          retryJitterRatio: 0.5,
        },
      })
      // 没配的那条走 mcp-client 自己的默认值：租户配置不替它兜数，`exclusiveTools` 与
      // `retryTools` 也一样，它把它们都补成空名单（不排除任何工具、也不额外允许重发）。
      expect(servers[1]).toMatchObject({
        serverName: 'uncapped',
        headers: {},
        failOnStartupError: false,
        toolConcurrency: {
          policy: 'annotations',
          maxConcurrentCalls: 10,
          exclusiveTools: [],
          retryTools: [],
          mode: 'adaptive',
          decreaseFactor: 0.5,
          recoveryStep: 1,
          recoveryQuietMs: 2000,
          countTimeouts: true,
          retryAttempts: 0,
          retryBaseDelayMs: 200,
          retryJitterRatio: 0.2,
        },
      })
      // 超时同样只在写了的时候透传，没写就按客户端的默认值生效。
      expect(servers[1]?.toolCallTimeoutMs).toBeGreaterThan(0)
    } finally {
      await app.dispose()
    }
  })

  it('failOnStartupError 为 true 的 server 连不上时启动失败并指名那一行，不写则安静挂上', async () => {
    // 客户端的默认值是 false：写错的地址或一次连不上只留一条日志，那一行安静地挂成“没有工具”，
    // 与“配置错误必须响亮失败”相反。部署示例逐条写 true，下面两段启动钉住这个差别。
    const down = `mcpServers:
  - serverName: mining
    transport: streamable-http
    url: http://127.0.0.1:1/mcp
`
    await expect(bootTools(configFrom(`${MINIMAL}${down}    failOnStartupError: true\n`))).rejects.toThrow(
      /组合行 mcp-0-mining（@deepseek-ai\/dsh-mcp-client）启动失败：mcp-client\(mining\): initial connection or tool synchronization failed/,
    )
    const app = await bootTools(configFrom(`${MINIMAL}${down}`))
    try {
      // 不写这个字段时按客户端的 false 生效：行照常挂上，只是这个 server 现在没有工具。
      expect(mountedConfigs(app, 'mcp-client')).toEqual([
        expect.objectContaining({ serverName: 'mining', failOnStartupError: false }),
      ])
    } finally {
      await app.dispose()
    }
  })

  it('只接受 mcp-client 真的有的传输方式，HTTP 入口之外的行响亮失败', () => {
    // mcp-client 的 Config 是 stdio / streamable-http 的判别联合，没有 sse：配置校验在这里说清，
    // 而不是让那一行在挂载时才失败。stdio 那一支（command/args/env）租户面暂不承载。
    expect(() => configFrom(`${MINIMAL}mcpServers:
  - serverName: mining
    transport: sse
    url: http://127.0.0.1:1/mcp
`)).toThrow(/配置\.mcpServers\[0\]\.transport 只能是 streamable-http，收到 sse/)
    expect(() => configFrom(`${MINIMAL}mcpServers:
  - serverName: mining
    transport: stdio
    command: npx
    url: http://127.0.0.1:1/mcp
`)).toThrow(/配置\.mcpServers\[0\] 有未知字段：command/)
    expect(() => configFrom(`${MINIMAL}mcpServers:
  - serverName: mining
    transport: streamable-http
    url: http://127.0.0.1:1/mcp
    headers:
      X-Api-Key: 12345
`)).toThrow(/配置\.mcpServers\[0\]\.headers\.X-Api-Key 必须是字符串/)
    expect(() => configFrom(`${MINIMAL}mcpServers:
  - serverName: mining
    transport: streamable-http
    url: http://127.0.0.1:1/mcp
    toolConcurrency:
      exclusiveTools: ['']
`)).toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.exclusiveTools\[0\] 必须是非空字符串/)
  })

  it('toolConcurrency 的每个键都在配置校验里，取值出错时指明键路径', () => {
    // 新增的键（`retryTools` 与自适应、重试那批）与老三个键走同一条路：名字写错是未知字段、
    // 取值越域是取值错误，两种都在配置加载时说清，不会拖到那一行挂载时。
    const withConcurrency = (body: string): string => `${MINIMAL}mcpServers:
  - serverName: mining
    transport: streamable-http
    url: http://127.0.0.1:1/mcp
    toolConcurrency:
${body}
`
    expect(() => configFrom(withConcurrency('      retryTool: [read_rows]\n')))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency 有未知字段：retryTool/)
    expect(() => configFrom(withConcurrency('      retryTools: [read_rows]\n      mode: fast\n')))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.mode 只能是 fixed \/ adaptive，收到 fast/)
    expect(() => configFrom(withConcurrency('      decreaseFactor: 2\n')))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.decreaseFactor 必须是 0 到 1 之间的数字/)
    expect(() => configFrom(withConcurrency('      retryAttempts: -1\n')))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.retryAttempts 必须是非负整数/)
    expect(() => configFrom(withConcurrency('      recoveryQuietMs: 1.5\n')))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.recoveryQuietMs 必须是正整数/)
    expect(() => configFrom(withConcurrency('      countTimeouts: yes\n')))
      .toThrow(/配置\.mcpServers\[0\]\.toolConcurrency\.countTimeouts 必须是布尔值/)
  })

  it('沙箱段把 provider 已有的可配置字段透传到容器运行时', async () => {
    const app = await bootTools(configFrom(MINIMAL.replace(
      '  backend: docker',
      '  backend: docker\n  maxOutputBytes: 134217728\n  cliTimeoutMs: 30000',
    )))
    try {
      expect(mountedConfigs(app, 'DockerContainerRuntime')[0])
        .toMatchObject({ maxOutputBytes: 134217728, cliTimeoutMs: 30000 })
    } finally {
      await app.dispose()
    }
  })
}, BOOT_TIMEOUT_MS)

describe('租户问答通道', () => {
  /** 只挂问答那几行：seam、工具、通道与它们依赖的提示词/工具运行时。 */
  async function bootQuestions(config: TenantAppConfig): Promise<TenantApp> {
    const { createTenantApp } = await import('../src/compose.ts')
    return await createTenantApp({
      ...config,
      plugins: {
        ...spineDisabled(),
        'system-prompt': { enabled: true },
        tools: { enabled: true },
        'user-questions': { enabled: true },
        'tool-ask-user': { enabled: true },
        'tenant-questions': { enabled: true },
      },
    })
  }

  it('挂上工具与通道，并把等待窗口配在 seam 的期限之内', async () => {
    const app = await bootQuestions(configFrom(MINIMAL))
    try {
      // 两个窗口都从清单取值：通道自己的窗口必须短于 seam 的，模型才看得到通道的超时原因。
      expect(mountedConfigs(app, 'UserQuestionService')).toEqual([{ answerTimeoutMs: 120000 }])
      expect(mountedConfigs(app, 'TenantQuestionService')).toEqual([{ answerTimeoutMs: 60000 }])
      expect(app.ctx.tools.schemas().map(schema => schema.name)).toContain('ask_user_question')
      expect(app.ctx.get('tenantQuestions')).toBeDefined()
    } finally {
      await app.dispose()
    }
  })

  it('通道那一行启用但能力缝没挂上时，组合响亮失败', async () => {
    const { createTenantApp } = await import('../src/compose.ts')
    const config = configFrom(MINIMAL)
    // 通道注入 seam：seam 那一行停用后，通道会被 Cordis 静默跳过。启动末尾的核对必须
    // 把这种「服务起来了但问答整块消失」报出来，而不是等到模型提问才发现没人能答。
    await expect(createTenantApp({
      ...config,
      plugins: {
        ...spineDisabled(),
        'tenant-questions': { enabled: true },
      },
    })).rejects.toThrow(/租户提问通道/)
  })

  it('网关那一行把问答提供者让给业务面通道', () => {
    // 缝只接受一个提供者，而网关的提供者走 web 客户端。清单里网关那一行必须显式让步，
    // 否则两行同挂时启动就以重复注册失败——这条断言是那次故障的守卫。
    const row = SPINE.find(candidate => candidate.id === 'api-gateway')
    expect(row?.config).toBeTypeOf('function')
    expect(row?.config?.(configFrom(MINIMAL))).toMatchObject({ userQuestionsProvider: false })
  })
}, BOOT_TIMEOUT_MS)

describe('租户技能三层根', () => {
  /** 技能那几行的 id；它们不带覆盖，挂不挂由清单自己的声明决定。 */
  const SKILL_ROWS = new Set(['skill', 'skill-filesystem', 'skill-tier'])

  /**
   * 只留技能那几行：其余清单行显式停用（它们要 Postgres 与沙箱）。
   *
   * 技能行**不给覆盖**：给了 `enabled: true` 就绕过了 `disabled`，这个测试也就问不出清单自己
   * 到底挂没挂读取者——这正是它要守的那件事。
   */
  async function bootSkills(config: TenantAppConfig): Promise<TenantApp> {
    const { createTenantApp } = await import('../src/compose.ts')
    return await createTenantApp({
      ...config,
      plugins: Object.fromEntries(
        SPINE.filter(row => !SKILL_ROWS.has(row.id)).map(row => [row.id, { enabled: false }]),
      ),
    })
  }

  /** 在一个技能根下写一份最小技能：目录形态的 `SKILL.md`，正文无关紧要。 */
  function writeSkill(root: string, skillName: string): void {
    mkdirSync(join(root, skillName), { recursive: true })
    writeFileSync(
      join(root, skillName, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: ${skillName} 的回归夹具\n---\n\n正文。\n`,
    )
  }

  /** 临时根下的路径写进 YAML：单引号标量让反斜杠保持字面量，Windows 上也能解析。 */
  function quoted(path: string): string {
    return `'${path}'`
  }

  it('系统层、用户全局层与案件层的技能都由清单推出的配置进到目录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tenant-skills-'))
    tempDirs.push(root)
    writeSkill(join(root, 'system', 'skills'), 'system-skill')
    writeSkill(join(root, 'users', 'staff-1', 'skills'), 'user-global-skill')
    writeSkill(join(root, 'case', 'shared', 'skills'), 'case-skill')

    // 三层根全部落在临时目录里，唯一能让它们进目录的路径是：skill-tier 发布三层根、
    // skill-filesystem 扫描它们。清单里少了读取者，或 systemSkillsDir 落到 $DSH_HOME，
    // 这里就只剩 sandbox 根之外的两个名字。
    const config = configFrom(MINIMAL
      .replace('  usersRoot: /srv/users', `  usersRoot: ${quoted(join(root, 'users'))}`)
      .replace('  backend: docker', `  backend: docker\n  systemRoot: ${quoted(join(root, 'system'))}`))
    const app = await bootSkills(config)
    try {
      const tenant: Tenant = {
        id: TenantId('acme'),
        name: 'acme',
        dataRoot: join(root, 'data'),
        workspaceRoot: join(root, 'case'),
      }
      const listed = await runWithTenant(
        tenant,
        () => runWithUser(UserId('staff-1'), () => app.ctx.skills.list()),
      )
      expect(listed.map(skill => skill.name).sort())
        .toEqual(['case-skill', 'system-skill', 'user-global-skill'])
    } finally {
      await app.dispose()
    }
  })

  it('未配置 systemRoot 的部署把系统层留给插件自己的默认值', () => {
    const row = SPINE.find(candidate => candidate.id === 'skill-tier')
    // 两个容器后端都把 `<systemRoot>/skills` 挂成沙箱的 system 技能层，宿主侧要扫的就是它；
    // 没配系统根的部署不传这一项，让 skill-tier 按 $DSH_HOME 自己解析。
    expect(row?.config?.(configFrom(K8S_MINIMAL))).toEqual({
      usersRoot: '/srv/users',
      systemSkillsDir: join('/srv/system', 'skills'),
    })
    expect(row?.config?.(configFrom(MINIMAL))).toEqual({ usersRoot: '/srv/users' })
  })

  it('技能读取者那一行不是停用行，且只扫三层根', () => {
    // 这一行是 `ctx.skillTiers` 的唯一读取者：它被停用，三层根就只是没人扫的配置。
    const reader = SPINE.find(candidate => candidate.id === 'skill-filesystem')
    expect(reader?.disabled).toBeUndefined()
    // 项目层与用户层根按宿主的 cwd 与 HOME 解析，在租户宿主里指向与租户无关的目录。
    expect(reader?.config?.(configFrom(MINIMAL))).toMatchObject({ includeDefaultRoots: false })
  })
}, BOOT_TIMEOUT_MS)
