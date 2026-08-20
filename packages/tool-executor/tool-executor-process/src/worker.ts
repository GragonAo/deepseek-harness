/**
 * Execution-worker entry: a standalone process owning a body registry, which
 * answers the process executor's `call`/`abort` frames over stdio NDJSON. The
 * registry here holds the worker's own bodies (the demo set in this first
 * cross-process stage); a later stage fills it with first-party execution-world
 * tools resolved by the same name an Agent Note describes.
 *
 * @module @deepseek-ai/dsh-tool-executor-process/worker
 */

import type { ToolBody, ToolExecutionValue } from '@deepseek-ai/dsh-tool-executor'
import type { WorkerToHost } from './protocol.ts'

/**
 * The worker's execution bodies, keyed by stable control-plane tool name. A
 * body is `(arguments, { signal }) => canonical value` — no agent, session, or
 * registry context crosses into this process.
 */
const bodies = new Map<string, ToolBody>()

const workspacePid: () => Promise<ToolExecutionValue> = () => Promise.resolve({ pid: process.pid })
const echo: ToolBody = (args: ToolExecutionValue) => Promise.resolve({ echoed: args, pid: process.pid })
const wait: ToolBody = async (_args, ctx) => {
  // Hangs until the host cancels, so the abort path has a deterministic peer.
  await new Promise<never>((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  })
  return null
}

bodies.set('exec:pid', workspacePid)
bodies.set('exec:echo', echo)
bodies.set('exec:wait', wait)

/** In-flight calls, keyed by host-issued id so an `abort` frame can cancel exactly one. */
const pending = new Map<number, AbortController>()

function send(message: WorkerToHost): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Handle one parsed inbound frame. Junk and unknown shapes are dropped without
 * a throw — a throw in this listener would crash the worker process.
 */
function handle(frame: unknown): void {
  if (typeof frame !== 'object' || frame === null) return
  const message = frame as Record<string, unknown>
  if (message.type === 'call') {
    const { id, name } = message
    if (typeof id !== 'number' || typeof name !== 'string') return
    const body = bodies.get(name)
    if (body === undefined) {
      send({ type: 'reply', id, failure: { kind: 'exception', message: `unknown tool "${name}" in execution worker` } })
      return
    }
    const controller = new AbortController()
    pending.set(id, controller)
    void (async () => {
      try {
        const value = await body(message.arguments as ToolExecutionValue, { signal: controller.signal })
        send({ type: 'reply', id, value })
      } catch (error: unknown) {
        send({ type: 'reply', id, failure: { kind: controller.signal.aborted ? 'abort' : 'exception', message: messageOf(error) } })
      } finally {
        pending.delete(id)
      }
    })()
    return
  }
  if (message.type === 'abort') {
    if (typeof message.id !== 'number') return
    pending.get(message.id)?.abort()
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += String(chunk)
  let index: number
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      // A co-shipped host never emits a malformed frame; ignore and keep reading.
      continue
    }
    handle(frame)
  }
})

send({ type: 'ready' })
