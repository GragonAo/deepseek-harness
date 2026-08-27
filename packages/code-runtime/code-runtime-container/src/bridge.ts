/**
 * Host-side binding bridge: a short-lived HTTP server that resolves the
 * binding calls a running container program makes. It exposes ONLY the
 * bindings of one in-flight request, carries a per-run secret token in its
 * URL path, binds an ephemeral port on all interfaces so the container can
 * reach it through the host name this deployment names, and closes with the
 * run.
 * @module @deepseek-ai/dsh-code-runtime-container/src/bridge
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { CodeBindingNamespace, CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'

/** One binding call, as the container posts it. */
export interface BindingCall {
  /** The namespace global the call names. */
  global: string
  /** The member name under that global. */
  name: string
  /** The call arguments (already parsed lossless JSON). */
  args: unknown
}

/** The settled outcome of one binding call. */
export type BindingResolution =
  | { ok: true; value: CodeJsonValue }
  | { ok: false; message: string }

/** A listening binding bridge plus its secret token and host port. */
export interface BindingBridge {
  /** The per-run secret; the container's URL is `http://<host>:<port>/<token>`. */
  readonly token: string
  /** The bound host port. */
  readonly port: number
  /** Close the server, settling once no connection remains. */
  close(): Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve one binding call against the run's declared namespaces, mirroring
 * the worker-thread backend's `onCall`: own-property lookup only (a forged
 * `constructor`/`__proto__` never walks the record's prototype chain), an
 * unknown name fails the call, and a lossy or throwing resolution fails the
 * call contained here — never a host crash.
 * @param bindings - the validated namespaces keyed by global.
 * @param call - the global, member name, and parsed args to dispatch.
 * @returns the call's settlement (value on success, message on failure).
 */
export async function resolveBindingCall(
  bindings: Map<string, CodeBindingNamespace>,
  call: BindingCall,
): Promise<BindingResolution> {
  const record = bindings.get(call.global)?.functions
  const fn = record !== undefined && Object.hasOwn(record, call.name) ? record[call.name] : undefined
  if (typeof fn !== 'function') {
    return { ok: false, message: `unknown binding ${JSON.stringify(`${call.global}.${call.name}`)}` }
  }
  try {
    const resolved = await fn(call.args)
    let value: CodeJsonValue | undefined
    try {
      value = snapshotJsonValue(resolved)
    } catch {
      value = undefined
    }
    if (value === undefined) {
      return { ok: false, message: 'binding resolution must be lossless JSON' }
    }
    return { ok: true, value }
  } catch (error: unknown) {
    return { ok: false, message: messageOf(error) }
  }
}

function respond(res: ServerResponse, status: number, body: BindingResolution): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * Start the one-run binding bridge on an ephemeral host port (`0.0.0.0:0` so
 * the container reaches it through the gateway host name). The per-run token
 * authenticates only the run that holds the URL.
 * @param bindings - the validated namespace map for the in-flight request.
 * @returns the listening bridge handle (token, port, close).
 */
export function createBindingBridge(bindings: Map<string, CodeBindingNamespace>): Promise<BindingBridge> {
  const token = randomBytes(32).toString('hex')
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'POST' || req.url !== `/${token}`) {
          respond(res, 404, { ok: false, message: 'not found' })
          return
        }
        const body = await readJson(req)
        if (typeof body !== 'object' || body === null) {
          respond(res, 400, { ok: false, message: 'body must be a JSON object' })
          return
        }
        const { global, name, args } = body as Record<string, unknown>
        if (typeof global !== 'string' || typeof name !== 'string') {
          respond(res, 400, { ok: false, message: 'call must name a string global and member' })
          return
        }
        respond(res, 200, await resolveBindingCall(bindings, { global, name, args }))
      } catch (error: unknown) {
        respond(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const address = server.address() as AddressInfo
      resolve({
        token,
        port: address.port,
        close: () => new Promise<void>((done) => { server.close(() => { done() }) }),
      })
    })
  })
}
