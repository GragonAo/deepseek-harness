/**
 * Runnable slice assembly: boots the tenant HTTP stack — bearer-JWT auth, a
 * per-tenant Postgres session persistence, the per-tenant container execution
 * world, and the tenant HTTP API — and registers the demo operation.
 * @module @deepseek-ai/dsh-tenant-demo/assembly
 */

import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { TenantRegistry } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import { JwtTenantAuthenticator } from '@deepseek-ai/dsh-tenant-auth-jwt'
import { PostgresSessionPersistence } from '@deepseek-ai/dsh-session-persistence-postgres'
import { DockerContainerRuntime } from '@deepseek-ai/dsh-container-docker'
import { ContainerSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-container'
import { ContainerFileSystem } from '@deepseek-ai/dsh-fs-container'
import { TenantHttpApi } from '@deepseek-ai/dsh-api-http'
import { makeDemoOperation } from './operation.ts'

/** Assembly inputs. */
export interface DemoConfig {
  /** PostgreSQL connection URI for the shared instance hosting every tenant schema. */
  connectionString: string
  /** Shared HMAC secret for HS256 bearer-JWT verification. */
  jwtSecret: string
  /** Expected `iss` of accepted tokens. */
  jwtIssuer: string
  /** HTTP listen port; `0` requests an OS-assigned port. */
  port?: number
  /** Container CLI: `docker` or `podman`. */
  runtime?: 'docker' | 'podman'
  /** Tenant records registered at boot. */
  tenants?: readonly Tenant[]
  /** Container path relative filesystem requests resolve against. */
  workspacePath?: string
}

/** A booted assembly. */
export interface DemoAssembly {
  readonly ctx: Context
  /** The listening HTTP port. */
  readonly port: number
  /** Register one more tenant record. */
  registerTenant(tenant: Tenant): () => void
  /** Dispose the whole stack (server, containers, database pool). */
  dispose(): Promise<void>
}

/**
 * Boot the full multi-tenant slice.
 * @param config - the assembly inputs.
 * @returns the booted stack.
 */
export async function assembleDemo(config: DemoConfig): Promise<DemoAssembly> {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: config.port ?? 0 })
  await ctx.plugin(SessionStore)
  await ctx.plugin(TenantRegistry)
  await ctx.plugin(JwtTenantAuthenticator, { issuer: config.jwtIssuer, secret: config.jwtSecret })
  await ctx.plugin(PostgresSessionPersistence, { connectionString: config.connectionString })
  await ctx.plugin(DockerContainerRuntime, { runtime: config.runtime ?? 'docker' })
  await ctx.plugin(ContainerSubprocessRuntime)
  await ctx.plugin(ContainerFileSystem, { root: config.workspacePath ?? '/workspace' })
  await ctx.plugin(TenantHttpApi, { path: '/v1/run' })

  const registry = ctx.tenants
  for (const tenant of config.tenants ?? []) registry.register(tenant)
  ctx.tenantHttpApi.register(makeDemoOperation(ctx))

  let disposed = false
  return {
    ctx,
    port: ctx.webServer.port,
    registerTenant: tenant => registry.register(tenant),
    dispose: async () => {
      if (disposed) return
      disposed = true
      await ctx.fiber.dispose()
    },
  }
}
