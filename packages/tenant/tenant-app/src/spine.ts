/**
 * 组合清单：租户服务挂载哪些插件、以什么默认配置挂载。
 *
 * 这份清单是租户栈自己的事实，不再从 dsh 的 bundle 补丁读取——bundle 属于 dsh 的分发形态，
 * 而租户服务是一份独立的组合。行的 `id` 与配置文件里 `plugins.<id>` 的写法一一对应，
 * 因此运维可以在不改代码的情况下停用一行或覆盖它的配置。
 *
 * 行里的模块名是字符串：装什么由清单决定，依赖可见性由 `./deps.ts` 的纯类型导入声明，
 * 所以既没有 90 条静态 import，静态分析也看得到全部依赖。配置值已在
 * {@link loadTenantAppConfig} 校验过，这里不重复校验。
 * @module @deepseek-ai/dsh-tenant-app/spine
 */

import { join, posix } from 'node:path'
import { SESSION_ID_PLACEHOLDER } from '@deepseek-ai/dsh-host-apiproxy'
import { SANDBOX_SESSIONS_MOUNT } from '@deepseek-ai/dsh-tenant'
import type { SpineModule } from './deps.ts'
import type { TenantAppConfig } from './types.ts'

/** 一行组合：挂哪块、怎么配、或者为什么不挂。 */
export interface SpineRow {
  /** 行标识，也是配置里 `plugins` 的键。 */
  readonly id: string
  /** 要挂载的模块名，只能取自 `./deps.ts` 声明的模块清单。 */
  readonly module: SpineModule
  /** 由租户配置推导出的默认配置。 */
  readonly config?: (config: TenantAppConfig) => Record<string, unknown>
  /** 不挂载的原因；写了这一项就不挂载。 */
  readonly disabled?: string
}

/**
 * `tools` 行的默认并发上限：32。
 *
 * 插件自己的默认值是 10，对数据挖掘的扇出偏低：一次挖掘是按分片或按表撒开的一批查询，
 * 32 路让约 180 个工具在 6 个波次里跑完，而同时在途的 HTTP 请求、结果缓冲与重新进入工具管线的
 * 子调用停在几十条这个量级。部署按 `tools.maxParallelSubCalls` 覆盖；单个 MCP 服务器的上限
 * 另由 `mcpServers[].toolConcurrency` 收紧。
 */
const DEFAULT_MAX_PARALLEL_SUB_CALLS = 32

/**
 * 执行容器里的默认工作目录：`/tmp/work`。
 *
 * 它只对不带会话的 exec 生效：带会话的命令都跑在该会话自己的目录里（`/sessions/<会话 id>`，
 * 即挂载进来的会话根下那一层，落在持久卷上，见 `sandboxSessionDir()`）。这个默认值是容器本地的
 * 路径：`/tmp` 是每个沙箱自己的 `emptyDir`，不是挂载点，所以它的内容随沙箱销毁而消失。分层挂载
 * （`/workspace`、`/case`、`/global`）是模型显式写绝对路径时的落点，也是发布工具唯一读得到的地方。
 * 部署按 `sandbox.workDir` 覆盖。
 */
const DEFAULT_WORK_DIR = '/tmp/work'

/**
 * 常驻终端的工作目录，也是不带会话的 exec 的默认目录：终端落在这里，而带会话的一次性命令跑在
 * 该会话自己的目录里，所以同一个会话的终端与命令的相对路径落点并不相同。
 *
 * @param config - 租户面配置，读它的 `sandbox.workDir` 与 `sandbox.backend`
 * @returns 执行容器里的默认工作目录：配置值优先，否则按后端取 `/tmp` 或 `/tmp/work`
 */
export function workDir(config: TenantAppConfig): string {
  if (config.sandbox.workDir !== undefined) return config.sandbox.workDir
  // docker 后端没有只读根，容器里的 /tmp 一定存在；k8s 后端由 provider 把 DEFAULT_WORK_DIR
  // 挂成 emptyDir，所以两条路径都必须与各自 provider 的默认值一致。
  return config.sandbox.backend === 'docker' ? '/tmp' : DEFAULT_WORK_DIR
}

/**
 * 新会话的工作目录模板：`/sessions/<会话 id>`，即 `sandboxSessionDir()` 的落点。
 *
 * 它是这个部署给「会话的工作目录在哪」的唯一答案：会话的命令跑在这里，文件工具的相对路径
 * 也解析到这里，而模型被 `sandbox:policy` 告知的工作区同样取它（那份说明由会话的 cwd 生成）。
 * 写死成容器本地的 `workDir` 会让三者互相矛盾：模型照说明把成品写进那个共享且随沙箱丢弃的
 * 目录，而它自己的命令与文件面看到的是另一层。
 *
 * 会话 id 由网关在创建时填进 {@link SESSION_ID_PLACEHOLDER}，所以这里只是一条模板。
 *
 * @param _config - 租户面配置；两个沙箱后端都把会话目录挂在 `/sessions` 下，模板与后端无关
 * @returns 传给 `dsh-host-apiproxy` 的 `cwd` 模板
 */
export function containerSessionDir(_config: TenantAppConfig): string {
  return posix.join(SANDBOX_SESSIONS_MOUNT, SESSION_ID_PLACEHOLDER)
}

/**
 * 系统层技能目录的宿主路径：`<sandbox.systemRoot>/skills`。
 *
 * `systemRoot` 是宿主上那棵全局配置树的根，两个容器后端都把它下面这一份 `skills/` 挂成沙箱的
 * system 技能层（`/opt/data/skills/system`），所以宿主侧要扫的就是它。未配置 `systemRoot` 的
 * 部署返回 `undefined`，由 `skill-tier` 按 `$DSH_HOME/system/skills` 自己解析。
 * @param config - 已校验的租户配置。
 * @returns 系统层技能目录的宿主路径；未配置系统根时为 `undefined`。
 */
function systemSkillsDir(config: TenantAppConfig): string | undefined {
  const root = config.sandbox.systemRoot
  return root === undefined ? undefined : join(root, 'skills')
}

/**
 * 全部组合行。
 *
 * 停用的行保留在清单里，是让“租户栈为什么没有这一块”有据可查：本地沙箱、单机 JSONL 存储与
 * 桌面形态的插件在租户服务里都由容器世界与 PostgreSQL 取代。
 *
 * 需要具名配置的那几块**不列在这里**：`compose.ts` 的静态挂载直接挂它们（会话、PostgreSQL
 * 会话持久化、容器 subprocess、WebServer、租户注册表与准入、两个 HTTP 面、容器沙箱后端），
 * 因为那些插件的配置来自租户配置的具名小节而不是清单里的闭包。同一模块在两处都挂会让它注册的
 * 服务重复，启动时直接失败。
 */
export const SPINE: readonly SpineRow[] = [
  { id: 'timer', module: '@deepseek-ai/cordis-plugin-timer' },
  { id: 'hmr', module: '@deepseek-ai/cordis-plugin-hmr', disabled: '服务进程不做热重载，重载只属于开发形态' },
  { id: 'llm', module: '@deepseek-ai/dsh-llm' },
  { id: 'typert', module: '@deepseek-ai/dsh-typert-registry' },
  { id: 'typert-loader', module: '@deepseek-ai/dsh-typert-loader' },
  { id: 'typert-gateway', module: '@deepseek-ai/dsh-api-gateway' },
  {
    id: 'api-gateway',
    module: '@deepseek-ai/dsh-host-apiproxy',
    // 提问这条缝只接受一个提供者。本栈的提供者是业务面的问答通道（下面的 tenant-questions
    // 行），所以网关不再自己注册那个走 web 客户端的提供者；两处同时注册会在启动时直接报重复注册。
    //
    // cwd 用带会话 id 的模板：会话的工作目录就是它在 /sessions 下的那一层，与那条会话自己的
    // 命令、文件读写是同一个落点（见 sandboxSessionDir）。写死成容器本地的 workDir 会让模型
    // 被告知「你的工作区是那个共享且随手丢弃的目录」，它就会把成品写到那里去。
    // 那一层由沙箱在会话第一条命令时建在挂载上，所以宿主不建——宿主上根本没有这个路径。
    config: config => ({
      cwd: containerSessionDir(config),
      createProjectDirectory: false,
      userQuestionsProvider: false,
    }),
  },
  {
    id: 'session-title',
    module: '@deepseek-ai/dsh-session-title',
    config: () => ({ fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }),
  },
  {
    id: 'session-title-llm',
    module: '@deepseek-ai/dsh-session-title-first-prompt-llm',
    config: () => ({ targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 }),
  },
  // 提问能力缝的 Service Definition。它自己不注册任何提供者，所以这一行必须开着：停用会让缝
  // 消失，下面 api-gateway 与 tenant-questions 两行的注入都不满足，业务面的 RPC 网关与 /api
  // 会一起挂不上，启动末尾的核对会直接报「组合里缺少这些服务」。
  { id: 'user-questions', module: '@deepseek-ai/dsh-user-questions', config: () => ({ answerTimeoutMs: 120000 }) },
  { id: 'agent', module: '@deepseek-ai/dsh-agent' },
  {
    id: 'agent-default-model',
    module: '@deepseek-ai/dsh-agent-default-model',
    config: config => ({ provider: config.model?.provider ?? 'deepseek-official', model: config.model?.model ?? 'deepseek-v4-flash' }),
  },
  { id: 'jobs', module: '@deepseek-ai/dsh-jobs-local' },
  { id: 'llm-retry', module: '@deepseek-ai/dsh-llm-retry' },
  { id: 'settings', module: '@deepseek-ai/dsh-settings-file', disabled: '租户设置落在 PostgreSQL 分区，文件形态是单机形态' },
  { id: 'credentials', module: '@deepseek-ai/dsh-credentials-local', disabled: '租户凭据落在 PostgreSQL 分区，环境变量形态是单机形态' },
  { id: 'settings-postgres', module: '@deepseek-ai/dsh-settings-postgres', config: config => ({ connectionString: config.database.connectionString }) },
  { id: 'credentials-postgres', module: '@deepseek-ai/dsh-credentials-postgres', config: config => ({ connectionString: config.database.connectionString }) },
  {
    id: 'llm-pi-ai',
    module: '@deepseek-ai/dsh-llm-pi-ai',
    disabled: '租户服务的模型供应商由部署方在配置里选；默认只留 deepseek 官方通道',
  },
  { id: 'llm-deepseek', module: '@deepseek-ai/dsh-llm-deepseek' },
  { id: 'session-persistence-jsonl', module: '@deepseek-ai/dsh-session-persistence-jsonl', disabled: '租户会话落在 PostgreSQL 分区' },
  { id: 'attachment-local', module: '@deepseek-ai/dsh-attachment-local' },
  { id: 'session-query-sqlite', module: '@deepseek-ai/dsh-session-query-sqlite', config: () => ({ path: ':memory:', openAt: 'never' }) },
  { id: 'session-projection', module: '@deepseek-ai/dsh-session-projection' },
  { id: 'session-projection-cache', module: '@deepseek-ai/dsh-session-projection-cache', disabled: '缓存服务于浏览器订阅，租户服务没有浏览器订阅' },
  { id: 'session-log-download', module: '@deepseek-ai/dsh-session-log-export' },
  { id: 'session-reference', module: '@deepseek-ai/dsh-session-reference' },
  { id: 'file-reference-local', module: '@deepseek-ai/dsh-file-reference-local' },
  { id: 'session-stats', module: '@deepseek-ai/dsh-session-stats' },
  {
    id: 'session-telemetry-otel',
    module: '@deepseek-ai/dsh-session-telemetry-otel',
    config: config => config.telemetry?.mode === 'OTLP'
      ? { mode: 'OTLP', exporter: { url: config.telemetry.url, compression: 'gzip', timeoutMillis: 1000 } }
      : { mode: 'DISABLED' },
  },
  { id: 'storage', module: '@deepseek-ai/dsh-storage' },
  { id: 'storage-json', module: '@deepseek-ai/dsh-storage-json', disabled: '租户存储后端是 PostgreSQL，JSON 文件形态是单机形态' },
  { id: 'storage-domain', module: '@deepseek-ai/dsh-storage-domain', config: () => ({ backend: 'postgres' }) },
  { id: 'storage-postgres', module: '@deepseek-ai/dsh-storage-postgres', config: config => ({ connectionString: config.database.connectionString }) },
  { id: 'workspace', module: '@deepseek-ai/dsh-workspace' },
  { id: 'message-feedback', module: '@deepseek-ai/dsh-message-feedback', disabled: '消息反馈由浏览器界面收集，租户服务没有该界面' },
  { id: 'plugin-inventory', module: '@deepseek-ai/dsh-host-plugin-inventory' },
  {
    id: 'directory-picker-auto',
    module: '@deepseek-ai/dsh-host-directory-picker-auto',
    disabled: '自适应选择器按宿主探测后端，服务端形态固定用下面的浏览式后端',
  },
  { id: 'directory-picker-browse', module: '@deepseek-ai/dsh-host-directory-picker-browse' },
  { id: 'subprocess', module: '@deepseek-ai/dsh-subprocess-local', disabled: '命令在租户沙箱容器里执行，由 subprocess-container 提供' },
  { id: 'sandbox', module: '@deepseek-ai/dsh-sandbox-local', disabled: '本地沙箱形态，租户沙箱在容器里' },
  { id: 'fs-sandbox', module: '@deepseek-ai/dsh-fs-sandbox', disabled: '文件系统由 fs-container 提供，落在租户沙箱内' },
  { id: 'bash-sandbox', module: '@deepseek-ai/dsh-bash-sandbox', disabled: 'bash 由 bash-local 走租户沙箱执行' },
  { id: 'pwsh-sandbox', module: '@deepseek-ai/dsh-pwsh-sandbox', disabled: '租户沙箱是 Linux，没有 PowerShell' },
  { id: 'bash-local', module: '@deepseek-ai/dsh-bash-local' },
  {
    id: 'sandbox-policy',
    module: '@deepseek-ai/dsh-sandbox-policy',
    config: config => ({ mode: config.permissions?.mode ?? 'workspace-write' }),
  },
  {
    id: 'approval',
    module: '@deepseek-ai/dsh-user-approval',
    config: config => ({ policy: approvalPolicy(config) }),
  },
  { id: 'permission', module: '@deepseek-ai/dsh-permission-presets', disabled: '本地权限档位由 sandbox-policy 与 approval 直接表达' },
  { id: 'shell-env', module: '@deepseek-ai/dsh-shell-env' },
  { id: 'tool-bash', module: '@deepseek-ai/dsh-tool-bash' },
  { id: 'tool-pwsh', module: '@deepseek-ai/dsh-tool-pwsh', disabled: '租户沙箱是 Linux，没有 PowerShell' },
  { id: 'tool-jobs', module: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'fs-observation-policy', module: '@deepseek-ai/dsh-fs-observation-policy' },
  { id: 'tool-fs', module: '@deepseek-ai/dsh-tool-fs' },
  {
    id: 'tool-fs-search',
    module: '@deepseek-ai/dsh-tool-fs-search',
    // 执行侧是租户容器：二进制由 tool-exec 镜像提供，宿主解析出的打包路径在容器里不存在。
    config: () => ({ sampleOverCapGlobResults: false, ripgrepPath: '/usr/local/bin/rg' }),
  },
  { id: 'agent-instructions', module: '@deepseek-ai/dsh-agent-instructions', config: () => ({ maxBytes: 65536 }) },
  { id: 'skill', module: '@deepseek-ai/dsh-skill' },
  {
    id: 'skill-filesystem',
    module: '@deepseek-ai/dsh-skill-filesystem',
    // 它是三层技能根的唯一读取者：同行下的 skill-tier 只发布 `ctx.skillTiers`，没人扫那三个目录
    // 就等于整层技能都不存在。项目层与用户层根按宿主的 cwd 与 HOME 解析，在租户宿主里指向与租户
    // 无关的目录（会话 cwd 是容器路径，宿主上没有），所以只留 skill-tier 的三层根。
    config: () => ({ includeDefaultRoots: false }),
  },
  {
    id: 'skill-tier',
    module: '@deepseek-ai/dsh-skill-tier',
    // 三层根都是宿主路径，必须按部署的实际目录给出：`usersRoot` 缺省会让用户全局层整层消失，
    // `systemSkillsDir` 缺省会按 $DSH_HOME 落到 `~/.dsh/system/skills`，而租户宿主没有那棵树——
    // 系统层技能在 `<sandbox.systemRoot>/skills`，两个容器后端也把这一份挂成沙箱的 system 层。
    config: config => ({
      usersRoot: config.tenants.usersRoot,
      ...(systemSkillsDir(config) !== undefined ? { systemSkillsDir: systemSkillsDir(config) } : {}),
    }),
  },
  { id: 'skill-badge', module: '@deepseek-ai/dsh-skill-badge' },
  {
    id: 'skill-install',
    module: '@deepseek-ai/dsh-skill-install',
    // 管理面的 `skills.*` 靠它装包：装完由它调 `ctx.skills.refresh()` 清掉进程级目录缓存。
    // 直接往三层根里放文件不触发 watcher，宿主那份缓存只有这一条路能刷新。默认开启：
    // 这一行停用后 `/admin/skills.upload` 会以 `skill-install-unavailable` 拒绝。
  },
  { id: 'tool-skill', module: '@deepseek-ai/dsh-tool-skill' },
  { id: 'tools-tier', module: '@deepseek-ai/dsh-tools-tier' },
  { id: 'tools-manifest', module: '@deepseek-ai/dsh-tools-manifest' },
  // 挂在清单加载器之后：三层目录的 `restriction.yaml` 由它应用，系统层那份在加载时就校验。
  { id: 'tools-restriction', module: '@deepseek-ai/dsh-tools-restriction' },
  { id: 'settings-tier', module: '@deepseek-ai/dsh-settings-tier' },
  { id: 'commands', module: '@deepseek-ai/dsh-commands' },
  { id: 'command-feedback', module: '@deepseek-ai/dsh-command-feedback' },
  { id: 'goal', module: '@deepseek-ai/dsh-goal' },
  { id: 'goal-round-driver', module: '@deepseek-ai/dsh-goal-round-driver' },
  { id: 'command-goal', module: '@deepseek-ai/dsh-command-goal' },
  { id: 'plan-mode', module: '@deepseek-ai/dsh-plan-mode' },
  { id: 'token-meter', module: '@deepseek-ai/dsh-token-meter' },
  { id: 'compaction-basic', module: '@deepseek-ai/dsh-compaction-basic' },
  { id: 'command-compact', module: '@deepseek-ai/dsh-command-compact' },
  { id: 'subagent', module: '@deepseek-ai/dsh-subagent' },
  { id: 'subagent-spawn-in-process', module: '@deepseek-ai/dsh-subagent-spawn-in-process', config: () => ({ providerName: 'spawn' }) },
  { id: 'subagent-fork-in-process', module: '@deepseek-ai/dsh-subagent-fork-in-process', config: () => ({ providerName: 'fork' }) },
  { id: 'tool-subagent-control', module: '@deepseek-ai/dsh-tool-subagent-control' },
  { id: 'tool-subagent-list-agents', module: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
  { id: 'tool-subagent', module: '@deepseek-ai/dsh-tool-subagent', config: () => ({ provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' }) },
  { id: 'tool-subagent-fork', module: '@deepseek-ai/dsh-tool-subagent', config: () => ({ provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'one-shot' }) },
  { id: 'tool-subagent-report', module: '@deepseek-ai/dsh-tool-subagent-report' },
  { id: 'workflow-container', module: '@deepseek-ai/dsh-workflow-container', config: () => ({ provider: 'spawn' }) },
  { id: 'tool-workflow', module: '@deepseek-ai/dsh-tool-workflow' },
  { id: 'timeout-policy', module: '@deepseek-ai/dsh-tool-call-timeout-policy' },
  { id: 'spill-local', module: '@deepseek-ai/dsh-spill-local' },
  { id: 'spill-policy', module: '@deepseek-ai/dsh-spill-policy', config: () => ({ maxInlineBytes: 50000 }) },
  { id: 'session-checkpoint-policy', module: '@deepseek-ai/dsh-session-checkpoint-policy' },
  { id: 'tool-result-pruner', module: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: () => ({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 }) },
  { id: 'tool-todo', module: '@deepseek-ai/dsh-tool-todo', config: () => ({ allowParallelInProgress: true }) },
  { id: 'tool-goal', module: '@deepseek-ai/dsh-tool-goal' },
  { id: 'tool-ralph', module: '@deepseek-ai/dsh-tool-ralph', config: () => ({ subagentProvider: 'spawn', maxRounds: 64 }) },
  { id: 'tool-str-replace-editor', module: '@deepseek-ai/dsh-tool-str-replace-editor', config: () => ({ maxOutputChars: 16000 }) },
  { id: 'repeat-tool-reminder', module: '@deepseek-ai/dsh-repeat-tool-reminder', config: () => ({ thresholds: [3, 5, 8], argumentsPreviewChars: 500 }) },
  { id: 'web', module: '@deepseek-ai/dsh-web', config: () => ({ searchProvider: 'deepseek-official' }) },
  { id: 'web-search-deepseek', module: '@deepseek-ai/dsh-web-search-deepseek', config: config => ({ apiKeyEnv: config.web?.searchApiKeyEnv ?? 'DEEPSEEK_API_KEY' }) },
  { id: 'tool-web', module: '@deepseek-ai/dsh-tool-web', config: () => ({ fetch: false, searchTimeoutMs: 60000 }) },
  // 呈现方式默认 both：原生 schema 与 run_code 的 SDK 声明同时下发，读一个文件、问一句这类
  // 会话不必写程序，而工具数以百计时的提示词成本由案件级可见工具清单压住——那份清单同时缩小
  // 原生 schema 段与 SDK 段（`<workspaceRoot>/tools/restriction.yaml`，见
  // tools-restriction README）。要让整个部署只走 run_code 通道，就把这个值改成 code；部署可配。
  {
    id: 'tools',
    module: '@deepseek-ai/dsh-tools',
    config: config => ({
      mode: config.tools?.mode ?? 'both',
      maxParallelSubCalls: config.tools?.maxParallelSubCalls ?? DEFAULT_MAX_PARALLEL_SUB_CALLS,
    }),
  },
  { id: 'system-prompt', module: '@deepseek-ai/dsh-system-prompt', config: () => ({ persona: '' }) },
  { id: 'agent-loop', module: '@deepseek-ai/dsh-agent-loop', config: () => ({ agents: [] }) },
  { id: 'agent-presets', module: '@deepseek-ai/dsh-agent-presets' },
  { id: 'code-runtime', module: '@deepseek-ai/dsh-code-runtime-worker-thread', disabled: '代码执行走租户沙箱，由 code-runtime-container 提供' },
  { id: 'code-runtime-container', module: '@deepseek-ai/dsh-code-runtime-container' },
  { id: 'cordis-host-runner', module: '@deepseek-ai/dsh-cordis-host-runner' },
  { id: 'tenant-admin-postgres', module: '@deepseek-ai/dsh-tenant-admin-postgres', config: config => ({ connectionString: config.database.connectionString }) },
  // 持久终端：会话注册表、沙箱里的交互式 shell 后端，以及两个吃它的工具。后端的类型名默认
  // `shell`，与两个工具自己的默认一致，所以这里不必再对齐一次。
  { id: 'terminal', module: '@deepseek-ai/dsh-terminal' },
  { id: 'terminal-container', module: '@deepseek-ai/dsh-terminal-container', config: config => ({ cwd: workDir(config) }) },
  { id: 'tool-terminal', module: '@deepseek-ai/dsh-tool-terminal' },
  // 常驻 bash 不单列一行：它注册的工具名与 `tool-bash` 同为 `bash`，两行同时挂载会在启动时
  // 报重复注册。要跨调用保留状态，用上面 terminal 行的常驻 PTY——租户沙箱里它就是同一个 shell。
  { id: 'tool-ask-user', module: '@deepseek-ai/dsh-tool-ask-user' },
  // 问答通道的等待窗口必须短于上面 user-questions 行的 120000：seam 自己的期限一到就以 abort
  // 撤回提问，再长也只会让模型看到 seam 的 NO_ANSWER，看不到本通道「谁没回答、等了多久」的超时原因。
  // 对象存储默认不挂：它需要部署给出端点、桶与对外下载基址，缺一项就起不来。哪些部署用得上，
  // 就在自己的 `plugins.object-store` 里把端点与桶写全并置 `enabled: true`；公开性由桶策略给出，
  // 属于部署步骤，不由这一行负责。
  {
    id: 'object-store',
    module: '@deepseek-ai/dsh-object-store',
    disabled: '对象存储的端点、桶与对外基址是部署专有的，未配置的部署不挂这一行',
  },
  { id: 'tenant-questions', module: '@deepseek-ai/dsh-tenant-questions', config: () => ({ answerTimeoutMs: 60000 }) },
]

/** 审批策略：显式配置优先，否则由权限档位推导（`danger-full-access` 不再追问）。 */
function approvalPolicy(config: TenantAppConfig): 'never' | 'ask' {
  if (config.permissions?.approval !== undefined) return config.permissions.approval
  return config.permissions?.mode === 'danger-full-access' ? 'never' : 'ask'
}
