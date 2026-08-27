/**
 * The demo tenant operation: one request-scoped run that proves the whole
 * slice — an authenticated tenant drives a container tool call inside its own
 * container (workspace mounted at `/workspace`), reads the result back through
 * the container filesystem, and persists a session event to its own tenant
 * schema.
 * @module @deepseek-ai/dsh-tenant-demo/operation
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { TenantOperation } from '@deepseek-ai/dsh-api-http'

/** The capability services one demo run consumes. */
export interface DemoDeps {
  readonly sessionPersistence: SessionPersistence
  readonly subprocess: SubprocessRuntime
  readonly fs: FileSystem
}

function newSessionId(tenantId: string): string {
  return `demo-${tenantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build the tenant-scoped demonstration operation.
 * @param deps - the session, subprocess, and filesystem services.
 * @returns the registered HTTP operation.
 */
export function makeDemoOperation(deps: DemoDeps): TenantOperation {
  return async ({ tenant }) => {
    const sessionId = SessionId(newSessionId(String(tenant.id)))
    await deps.sessionPersistence.create({ version: 0, id: sessionId, createdAt: Date.now() })

    const markerScript = `mkdir -p /workspace && printf '%s' '${String(tenant.id)}' > /workspace/demo-tenant.txt`
    const handle = deps.subprocess.spawn({
      argv: ['sh', '-c', markerScript],
      cwd: '/workspace',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 5000,
    })
    const outcome = await handle.done
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    if (outcome.exitCode !== 0) {
      throw new Error(`container tool call failed (exit ${String(outcome.exitCode)}): ${stderr}`)
    }

    const target = await deps.fs.resolve('/workspace/demo-tenant.txt')
    const marker = (await deps.fs.readText(target)).trim()

    await deps.sessionPersistence.append(sessionId, [{
      type: 'todo/write',
      seq: 0,
      time: Date.now(),
      data: { todos: [{ content: `tenant ${String(tenant.id)} marker=${marker}`, status: 'completed' }] },
    }])

    return { sessionId: String(sessionId), tenantId: String(tenant.id), marker }
  }
}
