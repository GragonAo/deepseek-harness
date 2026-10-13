/**
 * 租户服务的唯一启动入口：一份自有配置 + 一个手写组合。
 *
 * 这个包是租户栈的聚合点。它依赖的是 dsh 的核心层与能力位插件（会话、agent、工具、技能、
 * 文件系统、子进程），而不是 dsh 的 bundle、CLI 或 Loader——启动方式、配置格式与组合清单
 * 都归租户栈自己所有，因此不打包整个 dsh 也能起一个租户服务。
 * @module @deepseek-ai/dsh-tenant-app
 */

export { CONFIG_PATH_ENV, TenantAppConfigError, loadTenantAppConfig } from './config.ts'
export { createTenantApp } from './compose.ts'
export { SPINE } from './spine.ts'
export type { SpineRow } from './spine.ts'
export type {
  AdminConfig,
  AuthConfig,
  DatabaseConfig,
  DockerSandboxConfig,
  HttpConfig,
  JwksVerifyConfig,
  K8sSandboxConfig,
  McpServerConfig,
  ModelConfig,
  PermissionsConfig,
  PluginOverride,
  SandboxConfig,
  SandboxLayersConfig,
  SharedSecretVerifyConfig,
  SurfacesConfig,
  TelemetryConfig,
  TenantApp,
  TenantAppConfig,
  TenantDefaultsConfig,
  TenantsConfig,
  ToolsConfig,
  WebConfig,
} from './types.ts'
