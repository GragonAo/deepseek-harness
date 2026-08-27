/**
 * The workflow container's transport: a per-run token-authenticated duplex over
 * two plain HTTP endpoints. The host side (`createWorkflowBridge`) receives the
 * worker's one-way messages (POST) and serves the worker's long-poll (GET) from
 * a bounded queue of host-side messages. The container side
 * (`createHttpMessagePort`) adapts that surface into the `MessagePort` shape
 * `runWorkerSession` already speaks: `postMessage` POSTs, `on('message')` starts
 * the long-poll loop, `close()` aborts it. The same file serves both sides; the
 * two are split at bundle time (the container worker inlines only the port).
 * @module @deepseek-ai/dsh-workflow-container/transport
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { MessagePort } from 'node:worker_threads'
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '@deepseek-ai/dsh-workflow-worker-thread/src/protocol.ts'

/** The per-poll server-side hold: a waiter responds with one message or, on expiry, nothing. */
type MessageWaiter = (message: HostToWorkerMessage | null) => void
/** The long-poll hold in milliseconds; the worker re-polls on the empty response. */
const POLL_HOLD_MS = 25_000

/** A plain object carrying a string discriminator — the minimal wire-shape check. */
function isWireMessage(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/**
 * The host side of one run's duplex bridge. Binds an ephemeral port on all
 * interfaces so the tenant container reaches it through the gateway address
 * (`host.docker.internal`), and carries a per-run token in the URL path.
 */
export interface WorkflowBridge {
  /** The base URL the container POSTs to (`POST {url}`) and polls (`GET {url}/poll`). */
  readonly url: string
  /** Enqueue one host-side message for the worker's long-poll. */
  post(message: HostToWorkerMessage): void
  /** Sever every in-flight long-poll (empty reply) and release the port. */
  close(): Promise<void>
}

/**
 * Stand up the host-side bridge.
 * @param onMessage - delivers each valid worker→host message, in arrival order.
 * @param hostBridge - the hostname the container reaches the host by; the
 *   server binds all interfaces and `container-docker` publishes
 *   `host.docker.internal` (a local test uses `127.0.0.1`).
 * @returns the bridge handle; `close()` releases the port.
 */
export async function createWorkflowBridge(
  onMessage: (message: WorkerToHostMessage) => void,
  hostBridge = 'host.docker.internal',
): Promise<WorkflowBridge> {
  const token = randomBytes(32).toString('hex')
  const queue: HostToWorkerMessage[] = []
  const waiters: MessageWaiter[] = []
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== `/${token}` && pathname !== `/${token}/poll`) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method === 'POST' && pathname === `/${token}`) {
      // Worker → host: one fire-and-forget message per POST.
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        let value: unknown
        try {
          value = JSON.parse(body)
        } catch {
          res.writeHead(400)
          res.end()
          return
        }
        if (!isWireMessage(value)) {
          res.writeHead(400)
          res.end()
          return
        }
        try {
          onMessage(value as WorkerToHostMessage)
        } catch {
          // A listener fault must not take down the bridge; the run owns its
          // own terminal handling and the fault is already inside the protocol.
        }
        res.writeHead(204)
        res.end()
      })
      return
    }
    if (req.method === 'GET' && pathname === `/${token}/poll`) {
      // Host → worker: answer immediately from the queue, else hold the
      // response until a message is posted (woken by `post`) or the hold
      // expires with an empty 204 the worker re-polls.
      const queued = queue.shift()
      if (queued !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(queued))
        return
      }
      const waiter: MessageWaiter = (message) => {
        clearTimeout(timer)
        if (message === null) {
          res.writeHead(204)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(message))
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        waiter(null)
      }, POLL_HOLD_MS)
      // The hold must never keep the process alive past the run.
      timer.unref()
      waiters.push(waiter)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '0.0.0.0', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `http://${hostBridge}:${address.port}/${token}`,
    post(message) {
      // Wake the oldest held poll so the message is delivered promptly; with no
      // poll in flight, queue it for the next one (the worker's loop is the
      // single poller, so the waiters list holds at most one entry).
      const waiter = waiters.shift()
      if (waiter !== undefined) {
        waiter(message)
        return
      }
      queue.push(message)
    },
    async close() {
      for (const waiter of waiters.splice(0)) waiter(null)
      queue.length = 0
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

/**
 * The container side of one run's duplex: a `MessagePort`-shaped adapter that
 * POSTs worker messages and long-polls host messages. `on('message')` starts
 * the poll loop (the worker's session calls it before its Ready POST, so the
 * returning Go is already being awaited); `close()` aborts the loop and any
 * in-flight request so `node -e` can drain and exit.
 * @param bridgeUrl - the base URL supplied by the host (no `/poll` suffix).
 * @returns the adapter, usable wherever `runWorkerSession` expects a `MessagePort`.
 */
export function createHttpMessagePort(bridgeUrl: string): MessagePort {
  return new HttpMessagePort(bridgeUrl) as unknown as MessagePort
}

/** The port adapter; typed narrowly to the `postMessage`/`on`/`close` surface actually used. */
class HttpMessagePort {
  private handler: ((message: HostToWorkerMessage) => void) | undefined
  private readonly pollController = new AbortController()
  private readonly postController = new AbortController()
  private polling = false

  constructor(private readonly bridgeUrl: string) {}

  postMessage(message: WorkerToHostMessage): void {
    // Fire-and-forget: MessagePort.postMessage is synchronous and the host's
    // closed protocol has no per-message acknowledgement. The POST carries its
    // own abort signal so `close()` (which only aborts the poll) never severs a
    // message the worker has already sent — the terminal Result must land even
    // though the script's fire-and-forget send precedes the port close.
    void fetch(this.bridgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: this.postController.signal,
    }).catch(() => { /* aborted only if the bridge itself is gone; the outcome no longer depends on delivery */ })
  }

  on(event: string, listener: unknown): this {
    if (event === 'message') {
      this.handler = listener as (message: HostToWorkerMessage) => void
      this.startPolling()
    }
    return this
  }

  close(): void {
    this.pollController.abort()
  }

  private startPolling(): void {
    if (this.polling) return
    this.polling = true
    void (async () => {
      while (!this.pollController.signal.aborted) {
        const message = await this.pollOnce()
        if (message !== undefined) this.handler?.(message)
      }
    })().catch(() => { /* the abort on close ends the loop; nothing else can reject here */ })
  }

  private async pollOnce(): Promise<HostToWorkerMessage | undefined> {
    try {
      const response = await fetch(`${this.bridgeUrl}/poll`, { signal: this.pollController.signal })
      if (response.status !== 200) return undefined
      const value: unknown = await response.json()
      return isWireMessage(value) ? (value as HostToWorkerMessage) : undefined
    } catch {
      // Abort (close) or a severed connection ends the loop with no message.
      return undefined
    }
  }
}
