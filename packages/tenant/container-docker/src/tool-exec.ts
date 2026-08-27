/**
 * In-container tool-execution server (`tool-exec`): a minimal Node HTTP process
 * the Docker/Podman provider runs inside each tenant container. It exposes one
 * primitive — `POST /exec` — that spawns `argv` inside the container and returns
 * the exit code plus captured stdout/stderr. The agent plane reaches this server
 * by host address (ip+host); the container's own filesystem is ephemeral, with
 * the tenant workspace and tools carried in by bind mount. Bounds and timeouts
 * remain the subprocess capability's concern, so this surface mirrors
 * {@link ContainerRuntime.exec} exactly.
 * @module @deepseek-ai/dsh-container-docker/tool-exec
 */

import { spawn } from 'node:child_process'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'

/** `/exec` request body. */
export interface ToolExecRequest {
  /** The argument vector to spawn inside the container. */
  argv: string[]
  /** Working directory inside the container. */
  cwd?: string
  /** Extra environment entries layered onto the container process. */
  env?: Record<string, string>
  /** Bytes written to the spawned process stdin, then closed. */
  stdin?: string
}

/** `/exec` result body. */
export interface ToolExecResult {
  /** The spawned process exit code (spawn failure rejects instead). */
  exitCode: number
  /** Captured stdout decoded as UTF-8. */
  stdout: string
  /** Captured stderr decoded as UTF-8. */
  stderr: string
}

/** A listening tool-exec server plus its bound port (for `127.0.0.1` publication). */
export interface ListeningToolExecServer {
  readonly server: Server
  readonly port: number
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function badRequest(res: ServerResponse, message: string): void {
  respond(res, 400, { error: message })
}

function isToolExecRequest(value: unknown): value is ToolExecRequest {
  if (typeof value !== 'object' || value === null) return false
  const argv = (value as { argv?: unknown }).argv
  return Array.isArray(argv) && argv.length > 0 && argv.every((item): item is string => typeof item === 'string')
}

/**
 * Spawn `argv` inside the container and capture its streams.
 * @param req - the argument vector and optional stdin/env/cwd.
 * @returns the exit code and captured stdout/stderr.
 */
export function runCommand(req: ToolExecRequest): Promise<ToolExecResult> {
  const child = spawn(req.argv[0] as string, req.argv.slice(1), {
    cwd: req.cwd,
    env: req.env === undefined ? process.env : { ...process.env, ...req.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  if (req.stdin !== undefined) {
    child.stdin.write(req.stdin)
  }
  child.stdin.end()
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode) => {
      if (exitCode === null) {
        reject(new Error(`tool-exec: ${req.argv[0]} was killed by a signal before reporting an exit code`))
        return
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  return JSON.parse(text) as unknown
}

/**
 * Build the tool-exec HTTP server: `POST /exec` runs one command, any other
 * route or method is rejected. A non-JSON body or a missing `argv` is `400`.
 * @returns the un-listened HTTP server.
 */
export function createToolExecServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'POST' || req.url !== '/exec') {
          respond(res, 404, { error: 'tool-exec only serves POST /exec' })
          return
        }
        const body = await readJson(req)
        if (!isToolExecRequest(body)) {
          badRequest(res, 'body must be an object with a non-empty argv string array')
          return
        }
        const result = await runCommand(body)
        respond(res, 200, result)
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          badRequest(res, 'request body is not valid JSON')
          return
        }
        respond(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
}

/**
 * Listen the tool-exec server. The container entrypoint uses this as its one
 * long-lived process, binding the published container port on all interfaces.
 * @param port - container port to bind; `0` for an ephemeral loopback test port.
 * @param host - bind address; `0.0.0.0` so the Docker port mapping can reach it.
 * @returns the listening server plus its bound port, settling once the port is claimed.
 */
export function listenToolExecServer(port = 0, host = '0.0.0.0'): Promise<ListeningToolExecServer> {
  const server = createToolExecServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo
      resolve({ server, port: address.port })
    })
  })
}

/**
 * POST one command to a running tool-exec server and return its result.
 * @param baseUrl - the server's loopback address, e.g. `http://127.0.0.1:54321`.
 * @param req - the argument vector and optional stdin/env/cwd.
 * @param signal - optional cancellation forwarded to the HTTP request.
 * @returns the exit code and captured stdout/stderr.
 */
export async function execToolCommand(baseUrl: string, req: ToolExecRequest, signal?: AbortSignal): Promise<ToolExecResult> {
  const response = await fetch(`${baseUrl}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal: signal ?? null,
  })
  if (!response.ok) {
    let message = 'unknown error'
    try {
      const body = (await response.json()) as { error?: string }
      message = body.error ?? message
    } catch {
      // Non-JSON error body; keep the fallback message.
    }
    throw new Error(`tool-exec ${String(response.status)}: ${message}`)
  }
  return (await response.json()) as ToolExecResult
}
