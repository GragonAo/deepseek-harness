/**
 * Client half of the tool-exec protocol every container-runtime provider speaks
 * to a started sandbox: one HTTP primitive, `POST /exec`, which spawns an
 * argument vector inside the sandbox and returns its exit code and captured
 * streams. The server half is the sandbox image's entrypoint
 * (`@deepseek-ai/dsh-container-docker/src/tool-exec.ts`), which bundles these
 * request and result fields as types only, so both halves stay one contract.
 * @module @deepseek-ai/dsh-container-transport/tool-exec
 */

/** `/exec` request body. */
export interface ToolExecRequest {
  /** The argument vector to spawn inside the sandbox. */
  argv: string[]
  /** Working directory inside the sandbox. */
  cwd?: string
  /** Extra environment entries layered onto the spawned process. */
  env?: Record<string, string>
  /** Bytes written to the spawned process stdin, then closed. */
  stdin?: string
}

/** `/exec` result body. */
export interface ToolExecResult {
  /** The spawned process exit code (spawn failure rejects instead). */
  exitCode: number
  /** Captured stdout decoded as UTF-8（被沙箱内上界截断时只保留末尾一段）。 */
  stdout: string
  /** Captured stderr decoded as UTF-8（被沙箱内上界截断时只保留末尾一段）。 */
  stderr: string
  /**
   * stdout 被沙箱内的上界截断时为 true：这段文本是末尾一段，前面还有已经丢弃的字节。
   * 没有截断时这个字段不出现，调用方据此区分「这就是全部输出」。
   */
  stdoutTruncated?: boolean
  /** stderr 的同一件事，语义与 {@link ToolExecResult.stdoutTruncated} 相同。 */
  stderrTruncated?: boolean
}

/**
 * Tool-exec HTTP client seam (production: `fetch` to the sandbox's address;
 * tests inject a recorder).
 */
export interface ToolExecClient {
  /**
   * POST one command to a sandbox's tool-exec server.
   * @param baseUrl - the server's base address, e.g. `http://127.0.0.1:54321`.
   * @param req - the argument vector and optional stdin/env/cwd.
   * @param signal - the caller's fused deadline and cancellation, forwarded to the
   *   HTTP request; omit only when the caller has no bound of its own.
   * @returns the exit code and captured stdout/stderr.
   */
  exec(baseUrl: string, req: ToolExecRequest, signal?: AbortSignal): Promise<ToolExecResult>
}

/**
 * POST one command to a running tool-exec server and return its result.
 * @param baseUrl - the server's address, e.g. `http://172.17.0.5:8642`.
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
