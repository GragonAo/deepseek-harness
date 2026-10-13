/**
 * 组合清单的可装载模块名：与 `./spine.ts` 的每一行一一对应。
 *
 * 组合行按模块名（字符串）装载插件，静态分析看不到依赖，因此这里为每个模块名各写一条类型导入，
 * 让依赖对静态分析可见；类型导入不产出代码，也不受“路径映射直指 .ts 源文件”带来的重写限制影响。
 *
 * @module @deepseek-ai/dsh-tenant-app/deps
 */

import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/cordis-plugin-hmr'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/dsh-typert-loader'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-jobs-local'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-settings-file'
import type {} from '@deepseek-ai/dsh-credentials-local'
import type {} from '@deepseek-ai/dsh-settings-postgres'
import type {} from '@deepseek-ai/dsh-credentials-postgres'
import type {} from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-llm-deepseek'
import type {} from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-attachment-local'
import type {} from '@deepseek-ai/dsh-session-query-sqlite'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-log-export'
import type {} from '@deepseek-ai/dsh-session-reference'
import type {} from '@deepseek-ai/dsh-file-reference-local'
import type {} from '@deepseek-ai/dsh-session-stats'
import type {} from '@deepseek-ai/dsh-session-telemetry-otel'
import type {} from '@deepseek-ai/dsh-storage'
import type {} from '@deepseek-ai/dsh-storage-json'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-postgres'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-message-feedback'
import type {} from '@deepseek-ai/dsh-host-plugin-inventory'
import type {} from '@deepseek-ai/dsh-host-directory-picker-auto'
import type {} from '@deepseek-ai/dsh-host-directory-picker-browse'
import type {} from '@deepseek-ai/dsh-subprocess-local'
import type {} from '@deepseek-ai/dsh-sandbox-local'
import type {} from '@deepseek-ai/dsh-fs-sandbox'
import type {} from '@deepseek-ai/dsh-bash-sandbox'
import type {} from '@deepseek-ai/dsh-pwsh-sandbox'
import type {} from '@deepseek-ai/dsh-bash-local'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-tool-bash'
import type {} from '@deepseek-ai/dsh-tool-pwsh'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import type {} from '@deepseek-ai/dsh-fs-observation-policy'
import type {} from '@deepseek-ai/dsh-tool-fs'
import type {} from '@deepseek-ai/dsh-tool-fs-search'
import type {} from '@deepseek-ai/dsh-agent-instructions'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-skill-tier'
import type {} from '@deepseek-ai/dsh-skill-install'
import type {} from '@deepseek-ai/dsh-skill-badge'
import type {} from '@deepseek-ai/dsh-tool-skill'
import type {} from '@deepseek-ai/dsh-tools-tier'
import type {} from '@deepseek-ai/dsh-tools-manifest'
import type {} from '@deepseek-ai/dsh-tools-restriction'
import type {} from '@deepseek-ai/dsh-settings-tier'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-command-feedback'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-goal-round-driver'
import type {} from '@deepseek-ai/dsh-command-goal'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-compaction-basic'
import type {} from '@deepseek-ai/dsh-command-compact'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type {} from '@deepseek-ai/dsh-subagent-fork-in-process'
import type {} from '@deepseek-ai/dsh-tool-subagent-control'
import type {} from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import type {} from '@deepseek-ai/dsh-tool-subagent'
import type {} from '@deepseek-ai/dsh-tool-subagent-report'
import type {} from '@deepseek-ai/dsh-workflow-container'
import type {} from '@deepseek-ai/dsh-tool-workflow'
import type {} from '@deepseek-ai/dsh-tool-call-timeout-policy'
import type {} from '@deepseek-ai/dsh-spill-local'
import type {} from '@deepseek-ai/dsh-spill-policy'
import type {} from '@deepseek-ai/dsh-session-checkpoint-policy'
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-tool-goal'
import type {} from '@deepseek-ai/dsh-tool-ralph'
import type {} from '@deepseek-ai/dsh-tool-str-replace-editor'
import type {} from '@deepseek-ai/dsh-repeat-tool-reminder'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-web-search-deepseek'
import type {} from '@deepseek-ai/dsh-tool-web'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-code-runtime-worker-thread'
import type {} from '@deepseek-ai/dsh-code-runtime-container'
import type {} from '@deepseek-ai/dsh-cordis-host-runner'
import type {} from '@deepseek-ai/dsh-tenant-admin-postgres'
import type {} from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-terminal-container'
import type {} from '@deepseek-ai/dsh-tool-terminal'
import type {} from '@deepseek-ai/dsh-tool-bash-persistent'
import type {} from '@deepseek-ai/dsh-tool-ask-user'
import type {} from '@deepseek-ai/dsh-object-store'
import type {} from '@deepseek-ai/dsh-tenant-questions'

/**
 * 组合清单允许出现的全部模块名：与上面的类型导入一一对应，`SpineRow.module` 只能取这里的名字，
 * 所以清单里写错一个模块名是编译错误，而不是运行到那一行才失败。
 */
export const SPINE_MODULES = [
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-typert-loader',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-settings-file',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-settings-postgres',
  '@deepseek-ai/dsh-credentials-postgres',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-session-log-export',
  '@deepseek-ai/dsh-session-reference',
  '@deepseek-ai/dsh-file-reference-local',
  '@deepseek-ai/dsh-session-stats',
  '@deepseek-ai/dsh-session-telemetry-otel',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-postgres',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-message-feedback',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-host-directory-picker-auto',
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-skill-tier',
  '@deepseek-ai/dsh-skill-install',
  '@deepseek-ai/dsh-skill-badge',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tools-tier',
  '@deepseek-ai/dsh-tools-manifest',
  '@deepseek-ai/dsh-tools-restriction',
  '@deepseek-ai/dsh-settings-tier',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-command-feedback',
  '@deepseek-ai/dsh-goal',
  '@deepseek-ai/dsh-goal-round-driver',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-report',
  '@deepseek-ai/dsh-workflow-container',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-spill-local',
  '@deepseek-ai/dsh-spill-policy',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-repeat-tool-reminder',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-search-deepseek',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-code-runtime-container',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-tenant-admin-postgres',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-container',
  '@deepseek-ai/dsh-tool-terminal',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-object-store',
  '@deepseek-ai/dsh-tenant-questions',
] as const

/** 组合清单允许出现的模块名。 */
export type SpineModule = (typeof SPINE_MODULES)[number]
