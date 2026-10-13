/**
 * In-container tool-execution server (`tool-exec`): a minimal Node HTTP process
 * the Docker/Podman provider runs inside each tenant container. It exposes one
 * primitive — `POST /exec` — that spawns `argv` inside the container and returns
 * the exit code plus captured stdout/stderr. The agent plane reaches this server
 * by host address (ip+host); the container's own filesystem is ephemeral, with
 * the tenant workspace and tools carried in by bind mount. The raw capture of
 * each stream carries its own byte bound ({@link ToolExecServerOptions.maxOutputBytes}),
 * because the container holds the whole stream before the host's subprocess
 * capability can bound anything; result bounds and timeouts stay that
 * capability's concern, so this surface mirrors {@link ContainerRuntime.exec}.
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
  /** Captured stdout decoded as UTF-8（被上界截断时只保留末尾一段）。 */
  stdout: string
  /** Captured stderr decoded as UTF-8（被上界截断时只保留末尾一段）。 */
  stderr: string
  /**
   * stdout 超过 {@link ToolExecServerOptions.maxOutputBytes} 时为 true：这段文本是末尾一段，
   * 前面还有已经丢弃的字节。没有截断时这个字段不出现，调用方据此区分「这就是全部输出」。
   */
  stdoutTruncated?: boolean
  /** stderr 的同一件事，语义与 {@link ToolExecResult.stdoutTruncated} 相同。 */
  stderrTruncated?: boolean
}

/** A listening tool-exec server plus its bound port (for `127.0.0.1` publication). */
export interface ListeningToolExecServer {
  readonly server: Server
  readonly port: number
}

/**
 * 容器内空闲 watchdog 的装配参数。预算由部署配置给出、经 `DSH_TOOL_EXEC_IDLE_MS` 传进容器，
 * 判定用的时钟与退出通道是给测试的接缝：它们让「什么时候算空闲」可以在不真退出的前提下断言。
 */
export interface ToolExecServerOptions {
  /** 空闲多久后让容器自己退出（毫秒）；不设置则本容器永不自行退出。 */
  idleTimeoutMs?: number
  /**
   * 每次 exec 里**每条输出流**最多保留多少字节。预算由部署配置给出、经
   * `DSH_TOOL_EXEC_MAX_OUTPUT_BYTES` 传进容器。超过上界时容器继续读完这条流——停止读会让
   * 子进程在写满管道时阻塞，而它并不会因此变小——但只保留末尾一段，并把该流标成已截断。
   * 不设置则本容器不加上界（此时内存只受命令自己的输出规模约束，一条大输出命令能撑死沙箱）。
   */
  maxOutputBytes?: number
  /** 判定空闲的时钟。 */
  now?: () => number
  /** 退出通道；生产是 `process.exit`。 */
  exit?: (code: number) => void
  /** 判定间隔（毫秒）。 */
  idleCheckMs?: number
}

/** {@link ToolExecServerOptions.idleCheckMs} 的默认值：十分钟量级的预算下，误差不超过一秒。 */
export const DEFAULT_IDLE_CHECK_MS = 1_000

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
 * 一条输出流的带上界捕获。
 *
 * 超过上界之后**继续消费**这条流，只保留末尾一段：停止消费会让子进程在写满管道时阻塞，
 * 而它并不会因此变小。保留末尾而不是开头，与宿主自己的捕获一致——`ctx.subprocess` 的每条流预算
 * 同样只留诊断用的末尾一段，因此宿主截断时看到的内容，与只有容器截断时一样。
 *
 * 窗口从任意字节开始，所以保留文本的开头可能落在多字节字符中间，解码后是一个替换字符。
 */
class BoundedCapture {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private dropped = false

  /**
   * @param maxBytes - 保留上界；`undefined` 表示不加上界。
   */
  constructor(private readonly maxBytes: number | undefined) {}

  /**
   * 记下一段已经到达的输出；超出上界的部分立即丢弃。
   * @param chunk - 子进程刚写出的字节。
   */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.bytes += chunk.length
    const max = this.maxBytes
    if (max === undefined || this.bytes <= max) return
    // 超出上界：从头部丢到只剩末尾 max 字节。单块自己就超界时，这一段循环会把它切片，
    // 前面攒下的块整体丢弃。
    this.dropped = true
    while (this.bytes > max) {
      const head = this.chunks[0] as Buffer
      const excess = this.bytes - max
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
    }
  }

  /**
   * 收下这条流的结果。
   * @returns 解码后的保留文本，以及是否有字节被丢弃。
   */
  settle(): { text: string; truncated: boolean } {
    return { text: Buffer.concat(this.chunks).toString('utf8'), truncated: this.dropped }
  }
}

/**
 * 子进程 stdin 上报「它已经关掉自己的输入」这一类写入错误的错误码：子进程提前退出时它的 stdin
 * 读端随之关闭，剩下没送完的写入于是失败——POSIX 报 `EPIPE`，Windows 经 libuv 报 `EOF`，
 * 两端都消失时还可能报 `ECONNRESET`。三者都只说明子进程不再读输入，与这条命令是否失败无关。
 */
const CLOSED_STDIN_CODES: ReadonlySet<NodeJS.ErrnoException['code']> = new Set(['EPIPE', 'EOF', 'ECONNRESET'])

function isClosedStdin(error: unknown): boolean {
  return CLOSED_STDIN_CODES.has((error as NodeJS.ErrnoException).code)
}

/**
 * Spawn `argv` inside the container and capture its streams.
 *
 * 子进程已经退出、只是没读完 stdin 的调用仍算正常完成——它的退出码与已捕获输出就是这次调用的答案；
 * 拉起失败、被信号杀死、以及 stdin 写入以其它的错误码失败，都以拒绝回报。
 * @param req - the argument vector and optional stdin/env/cwd.
 * @param maxOutputBytes - 每条输出流最多保留多少字节；省略则不加上界。
 * @returns the exit code and captured stdout/stderr，被截断的流带 `*Truncated` 标记。
 */
export function runCommand(req: ToolExecRequest, maxOutputBytes?: number): Promise<ToolExecResult> {
  const child = spawn(req.argv[0] as string, req.argv.slice(1), {
    cwd: req.cwd,
    env: req.env === undefined ? process.env : { ...process.env, ...req.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = new BoundedCapture(maxOutputBytes)
  const stderr = new BoundedCapture(maxOutputBytes)
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  return new Promise<ToolExecResult>((resolve, reject) => {
    child.on('error', reject)
    // 只接管 stdin 这条流，不把整个流程包进 try：能到达这里的只有这条管道的写入错误。吞掉的是
    // 「子进程已经关掉自己的输入」这一种，其余错误码一律交给调用方当失败看见；没有这个监听时，
    // 被吞掉的那一种是未处理流错误，而它打死的沙箱里整条 exec 通道。
    child.stdin.on('error', (error: Error) => {
      if (isClosedStdin(error)) return
      reject(new Error(`tool-exec: writing ${req.argv[0]} stdin failed: ${error.message}`))
    })
    if (req.stdin !== undefined) {
      child.stdin.write(req.stdin)
    }
    child.stdin.end()
    child.on('close', (exitCode) => {
      if (exitCode === null) {
        reject(new Error(`tool-exec: ${req.argv[0]} was killed by a signal before reporting an exit code`))
        return
      }
      const out = stdout.settle()
      const err = stderr.settle()
      resolve({
        exitCode,
        stdout: out.text,
        stderr: err.text,
        ...out.truncated ? { stdoutTruncated: true } : {},
        ...err.truncated ? { stderrTruncated: true } : {},
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
 *
 * 设置 {@link ToolExecServerOptions.idleTimeoutMs} 时，服务器还会看着自己有没有活干：
 * **没有在途请求、且距上一次请求到达已超过预算**，就调用 `exit`。在途计数是必需的——
 * 一条比预算更长的构建是一条正在执行的命令，不是「这个沙箱没人用」；计时因此从命令结束算起，
 * 与两个 provider 自己的空闲回收同一条规则。
 * @param options - 空闲预算与输出上界，以及判定时钟与退出通道。
 * @returns the un-listened HTTP server.
 */
export function createToolExecServer(options: ToolExecServerOptions = {}): Server {
  const now = options.now ?? Date.now
  const exit = options.exit ?? ((code: number): void => { process.exit(code) })
  const idleTimeoutMs = options.idleTimeoutMs
  const maxOutputBytes = options.maxOutputBytes
  let lastActivityAt = now()
  let inFlight = 0
  const server = createServer((req, res) => {
    inFlight += 1
    lastActivityAt = now()
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
        const result = await runCommand(body, maxOutputBytes)
        respond(res, 200, result)
      } catch (error: unknown) {
        if (error instanceof SyntaxError) {
          badRequest(res, 'request body is not valid JSON')
          return
        }
        respond(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })().finally(() => {
      inFlight -= 1
      lastActivityAt = now()
    })
  })
  if (idleTimeoutMs !== undefined) {
    const timer = setInterval(() => {
      if (inFlight > 0) return
      if (now() - lastActivityAt < idleTimeoutMs) return
      // 判定只做一次：退出之后没有「下一次」了。
      clearInterval(timer)
      exit(0)
    }, options.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS)
    // 这个计时器不该成为进程活下去的理由：它只是想收回一个没人用的容器。
    timer.unref()
    server.on('close', () => { clearInterval(timer) })
  }
  return server
}

/**
 * Listen the tool-exec server. The container entrypoint uses this as its one
 * long-lived process, binding the published container port on all interfaces.
 * @param port - container port to bind; `0` for an ephemeral loopback test port.
 * @param host - bind address; `0.0.0.0` so the Docker port mapping can reach it.
 * @param options - 空闲预算与输出上界，以及判定时钟与退出通道。
 * @returns the listening server plus its bound port, settling once the port is claimed.
 */
export function listenToolExecServer(port = 0, host = '0.0.0.0', options: ToolExecServerOptions = {}): Promise<ListeningToolExecServer> {
  const server = createToolExecServer(options)
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
 * @param signal - the caller's fused deadline and cancellation, forwarded to the
 *   HTTP request; omit only when the caller has no bound of its own.
 * @returns the exit code and captured stdout/stderr.
 */
export async function execToolCommand(baseUrl: string, req: ToolExecRequest, signal?: AbortSignal): Promise<ToolExecResult> {
  const response = await fetch(`${baseUrl}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    // The field is omitted, not set to null: a request with no signal has no
    // deadline at all, which is what a server that stopped answering hangs on.
    ...signal !== undefined ? { signal } : {},
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
