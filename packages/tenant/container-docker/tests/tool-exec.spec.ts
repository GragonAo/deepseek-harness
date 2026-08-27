import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listenToolExecServer } from '../src/tool-exec.ts'
import type { ListeningToolExecServer } from '../src/tool-exec.ts'

describe('tool-exec server', () => {
  let running: ListeningToolExecServer
  let base: string

  const exec = (body: unknown): Promise<Response> => fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  beforeAll(async () => {
    running = await listenToolExecServer()
    base = `http://127.0.0.1:${running.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      running.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('runs argv and returns exit code plus captured streams', async () => {
    const response = await exec({ argv: ['sh', '-c', 'printf out; printf err >&2; exit 3'] })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' })
  })

  it('feeds stdin and forwards env', async () => {
    const response = await exec({
      argv: ['sh', '-c', 'cat; printf "%s" "$TOOL_EXEC_TEST"'],
      env: { TOOL_EXEC_TEST: 'present' },
      stdin: 'piped-in',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ exitCode: 0, stdout: 'piped-inpresent', stderr: '' })
  })

  it('resolves relative commands against the forwarded cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-exec-'))
    writeFileSync(join(dir, 'marker.txt'), 'from-cwd')
    try {
      const response = await exec({ argv: ['sh', '-c', 'cat marker.txt'], cwd: dir })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ exitCode: 0, stdout: 'from-cwd', stderr: '' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a missing-empty argv with 400', async () => {
    const response = await exec({ argv: [] })
    expect(response.status).toBe(400)
  })

  it('rejects a non-exec entrypoint with 404', async () => {
    const response = await fetch(`${base}/nope`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('reports a missing binary as a spawn failure', async () => {
    const response = await exec({ argv: ['tool-exec-definitely-missing-binary'] })
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toContain('ENOENT')
  })
})
