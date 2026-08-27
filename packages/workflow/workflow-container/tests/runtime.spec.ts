import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { WorkerInit } from '@deepseek-ai/dsh-workflow-worker-thread/src/types.ts'
import { WorkerToHostType, HostToWorkerType } from '@deepseek-ai/dsh-workflow-worker-thread/src/protocol.ts'
import type { WorkerToHostMessage } from '@deepseek-ai/dsh-workflow-worker-thread/src/protocol.ts'
import { createWorkflowBridge } from '../src/transport.ts'
import type { WorkflowBridge } from '../src/transport.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const workerBundle = readFileSync(`${packageRoot}/lib/container-worker.js`, 'utf8')

const LIMITS = { maxConcurrentAgents: 2, maxTotalAgents: 10, maxItemsPerCall: 10, syncTimeoutMs: 5000 }

/**
 * Run the built container worker under plain Node against the real in-process
 * bridge and return the host-side message stream. Go is answered on Ready;
 * `onMessage` collects each message. The init payload rides the
 * `DSH_WORKFLOW_INIT` env var; the bundle rides a temp file rather than stdin
 * because its size exceeds the Windows command-line ceiling (the deployment's
 * stdin launch mode is launch-mode-agnostic for this transport test).
 * @param init - the run payload (the container worker reads it from
 *   `DSH_WORKFLOW_INIT`).
 * @returns the collected worker→host messages once the child exits.
 */
async function runWorker(init: WorkerInit): Promise<WorkerToHostMessage[]> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-container-'))
  const entry = join(dir, 'worker.mjs')
  await writeFile(entry, workerBundle)
  try {
    return await new Promise((resolve, reject) => {
      void (async () => {
        const messages: WorkerToHostMessage[] = []
        const bridge: WorkflowBridge = await createWorkflowBridge((message) => {
          messages.push(message)
          if (message.type === WorkerToHostType.Ready) bridge.post({ type: HostToWorkerType.Go })
        }, '127.0.0.1')
        const child = spawn(process.execPath, [entry], {
          env: { ...process.env, DSH_WORKFLOW_BRIDGE: bridge.url, DSH_WORKFLOW_INIT: JSON.stringify(init) },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => { stderr += chunk })
        child.on('error', (error) => { void bridge.close(); reject(error) })
        child.on('close', (code) => {
          void bridge.close().then(() => {
            if (code === 0) resolve(messages)
            else reject(new Error(`worker exited ${code}: ${stderr}`))
          })
        })
        child.stdin.end()
      })().catch(reject)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('container workflow worker transport', () => {
  it('runs the unchanged runWorkerSession over the HTTP duplex for a no-agent script', async () => {
    const messages = await runWorker({
      meta: { name: 'transport-smoke', description: 'transport smoke' },
      body: "phase('build'); log('hello from the container'); return 7",
      limits: LIMITS,
    })
    expect(messages.map(m => m.type)).toEqual(['ready', 'phase', 'log', 'result'])
    const phase = messages[1]
    const log = messages[2]
    const result = messages[3]
    expect(phase).toMatchObject({ type: 'phase', title: 'build' })
    expect(log).toMatchObject({ type: 'log', message: 'hello from the container' })
    expect(result).toMatchObject({ type: 'result', result: { value: 7, stopReason: 'completed', agentsStarted: 0 } })
  }, 30_000)
})
