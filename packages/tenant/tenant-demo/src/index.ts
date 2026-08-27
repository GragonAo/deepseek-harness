/**
 * Runnable end-to-end multi-tenant slice assembly: bearer-JWT auth, per-tenant
 * Postgres sessions, per-tenant container tool execution, and the tenant HTTP
 * API, wired and bootable together.
 * @module @deepseek-ai/dsh-tenant-demo
 */

export { assembleDemo } from './assembly.ts'
export type { DemoAssembly, DemoConfig } from './assembly.ts'
export { makeDemoOperation } from './operation.ts'
export type { DemoDeps } from './operation.ts'
