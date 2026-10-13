import { describe, expect, it } from 'vitest'
import { cliRunner, execToolCommand } from '../src/index.ts'

/**
 * 进程级未处理错误：断言某次调用没有把它们漏到宿主进程上（漏出去的那一个会打死宿主）。
 * @returns 收集到的错误，以及用完必须调用的摘除。
 */
function watchProcessErrors(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = []
  const onUncaught = (error: unknown): void => { errors.push(error) }
  const onRejection = (reason: unknown): void => { errors.push(reason) }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
  return {
    errors,
    stop: () => {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onRejection)
    },
  }
}

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

  it('settles a child that exited without reading the stdin it was fed', async () => {
    const runner = cliRunner(process.execPath)
    const watch = watchProcessErrors()
    try {
      // 1 MiB 远超管道缓冲，而这个子进程从不读 stdin：剩下没送完的写入必然失败。
      const result = await runner.run(['-e', 'process.exit(0)'], { stdin: 'x'.repeat(1_048_576) })
      // 子进程已经退出，它的退出码就是这次调用的答案——管道写不完不是它的失败。
      expect(result).toMatchObject({ exitCode: 0 })
      // 那条管道的写入错误在 close 之后才到，所以先让它有机会落地再断言没有漏出去。
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
      expect(watch.errors).toEqual([])
    } finally {
      watch.stop()
    }
  })

  it('rejects a start that failed, naming the binary it could not run', async () => {
    const runner = cliRunner('dsh-cli-that-does-not-exist')
    await expect(runner.run(['version'])).rejects.toThrow(/dsh-cli-that-does-not-exist/)
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
