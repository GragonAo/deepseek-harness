import { describe, expect, it } from 'vitest'
import { cliRunner, execToolCommand } from '../src/index.ts'

describe('cliRunner', () => {
  it('runs the configured binary and captures its exit code and streams', async () => {
    const runner = cliRunner(process.execPath)
    const result = await runner.run(['-e', 'process.stdout.write("out"); process.stderr.write("err")'])
    expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' })
  })

  it('feeds stdin to the spawned process and closes it', async () => {
    const runner = cliRunner(process.execPath)
    const result = await runner.run(['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'piped' })
    expect(result.stdout).toBe('piped')
  })

  it('reports a non-zero exit code as a result rather than a rejection', async () => {
    const runner = cliRunner(process.execPath)
    const result = await runner.run(['-e', 'process.exit(3)'])
    expect(result.exitCode).toBe(3)
  })

  it('kills the child when the caller aborts', async () => {
    const runner = cliRunner(process.execPath)
    const controller = new AbortController()
    const pending = runner.run(['-e', 'setTimeout(() => {}, 30000)'], { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ exitCode: 0 })
  })
})

describe('execToolCommand', () => {
  it('rejects with the server message when the endpoint reports an error', async () => {
    const server = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      await expect(execToolCommand(`http://127.0.0.1:${String(port)}`, { argv: ['sh'] }))
        .rejects.toThrow('tool-exec 500: boom')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})
