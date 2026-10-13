import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listenToolExecServer } from '../src/tool-exec.ts'
import type { ListeningToolExecServer, ToolExecRequest, ToolExecResult } from '../src/tool-exec.ts'

/**
 * 命令一律用 Node 自己跑：这套用例在宿主进程内起服务器，而宿主不一定有 `sh`
 * （Windows 上通常没有），所以每条命令都用 `process.execPath -e` 表达。
 */
describe('tool-exec server', () => {
  let running: ListeningToolExecServer
  let base: string

  const exec = (body: unknown): Promise<Response> => fetch(`${base}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  /**
   * 跑一段会触发子进程流错误的请求，并断言进程级事件上没留下未处理错误。
   * 只在断言期间接管这两个事件、结束就摘掉，所以它不会把未处理错误变成全局静默。
   * @param body - 触发那条流错误并断言结果体的请求。
   */
  async function withoutUnhandledErrors(body: () => Promise<void>): Promise<void> {
    const unhandled: unknown[] = []
    const capture = (value: unknown): void => { unhandled.push(value) }
    process.on('uncaughtException', capture)
    process.on('unhandledRejection', capture)
    try {
      await body()
      // 流错误异步到达：先给它机会到达，再断言没有人接到它。
      await settle(200)
      expect(unhandled).toEqual([])
    } finally {
      process.off('uncaughtException', capture)
      process.off('unhandledRejection', capture)
    }
  }

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
    // exitCode 而不是 process.exit：管道上的写是异步的，process.exit 会把还没送出的输出丢掉。
    const response = await exec({ argv: [process.execPath, '-e', "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"] })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' })
  })

  it('feeds stdin and forwards env', async () => {
    const response = await exec({
      argv: [process.execPath, '-e', "let received = ''; process.stdin.on('data', (chunk) => { received += chunk }); process.stdin.on('end', () => { process.stdout.write(received + process.env.TOOL_EXEC_TEST) })"],
      env: { TOOL_EXEC_TEST: 'present' },
      stdin: 'piped-in',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ exitCode: 0, stdout: 'piped-inpresent', stderr: '' })
  })

  it('completes normally when the command exits without reading its stdin', async () => {
    // 子进程提前退出会关掉自己的 stdin 读端，剩下没送完的写入以 EPIPE 报出（Windows 上是 EOF）。
    await withoutUnhandledErrors(async () => {
      // 4 MiB 远超管道缓冲：这条命令写一行输出就退出，从不读 stdin。
      const response = await exec({
        argv: [process.execPath, '-e', "process.stdout.write('early'); process.exitCode = 7"],
        stdin: 'x'.repeat(4 * 1024 * 1024),
      })
      // 命令已经退出，它的退出码与输出就是这次调用的答案，没送完的 stdin 不改变这一点。
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ exitCode: 7, stdout: 'early', stderr: '' })
    })
  })

  it('reports a spawn failure rather than the stdin write that follows it', async () => {
    await withoutUnhandledErrors(async () => {
      // 拉起失败时 stdin 已经是一条被销毁的管道：写入它同样报错，但这次调用的失败原因是命令
      // 没跑起来，不是 stdin 没送出去。
      const response = await exec({ argv: ['tool-exec-definitely-missing-binary'], stdin: 'x'.repeat(64 * 1024) })
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error?: string }
      expect(body.error).toContain('ENOENT')
    })
  })

  it('resolves relative paths against the forwarded cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-exec-'))
    writeFileSync(join(dir, 'marker.txt'), 'from-cwd')
    try {
      const response = await exec({
        argv: [process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))"],
        cwd: dir,
      })
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

/**
 * 输出上界：容器先把原始流攒满才轮得到宿主加界，所以这个上界必须在容器里生效，
 * 而且必须是「继续 drain、只留末尾一段、把截断说出来」——不是把命令杀掉。
 * 命令用 Node 自己，这套用例因此不依赖宿主有没有 `sh`。
 */
describe('tool-exec output bound', () => {
  /** 一条只写一条流的命令：内容确定，末尾带一个用来分辨「保留的是末尾」的标记。 */
  function writer(bytes: number, stream: 'stdout' | 'stderr' = 'stdout', tail = ''): string {
    return `process.${stream}.write('x'.repeat(${String(bytes)}) + ${JSON.stringify(tail)})`
  }

  /** 起一个带上界的服务器，返回它的地址与一个关闭函数。 */
  async function bounded(maxOutputBytes: number | undefined): Promise<{ base: string; close: () => Promise<void> }> {
    const running = await listenToolExecServer(0, '127.0.0.1', maxOutputBytes === undefined ? {} : { maxOutputBytes })
    return {
      base: `http://127.0.0.1:${running.port}`,
      close: () => new Promise<void>((resolve, reject) => {
        running.server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      }),
    }
  }

  /**
   * 在某个服务器上跑一条命令，返回解析后的结果体。
   * @param extra - `argv` 以外的请求字段（stdin / cwd / env），上界与它们组合时用。
   */
  async function run(base: string, script: string, extra: Omit<Partial<ToolExecRequest>, 'argv'> = {}): Promise<ToolExecResult> {
    const response = await fetch(`${base}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ argv: [process.execPath, '-e', script], ...extra }),
    })
    expect(response.status).toBe(200)
    return await response.json() as ToolExecResult
  }

  it('returns output below the bound unchanged, with no truncation reported', async () => {
    const server = await bounded(4096)
    try {
      const result = await run(server.base, writer(64, 'stdout', 'END'))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${'x'.repeat(64)}END`)
      // 没有截断时这个字段不出现：调用方据此知道这就是全部输出。
      expect(result.stdoutTruncated).toBeUndefined()
      expect(result.stderrTruncated).toBeUndefined()
      expect(result.stderr).toBe('')
    } finally {
      await server.close()
    }
  })

  it('returns output of exactly the bound unchanged', async () => {
    const server = await bounded(4096)
    try {
      const result = await run(server.base, writer(4096))
      expect(result.stdout.length).toBe(4096)
      expect(result.stdoutTruncated).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('keeps exactly the tail of one byte over the bound and reports the truncation', async () => {
    const server = await bounded(4096)
    try {
      const result = await run(server.base, writer(4096, 'stdout', 'TAIL'))
      // 末尾标记还在，说明留下的是最后一段而不是开头一段。
      expect(result.stdout).toBe(`${'x'.repeat(4092)}TAIL`)
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('keeps the last bytes of a single write that is larger than the bound', async () => {
    const server = await bounded(1000)
    try {
      // 一次 write 就有 256 KiB，必然整块超过 1000 字节的上界。
      const result = await run(server.base, writer(256 * 1024, 'stdout', 'TAIL'))
      expect(result.stdout).toBe(`${'x'.repeat(996)}TAIL`)
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('keeps only the last byte under a one-byte bound', async () => {
    const server = await bounded(1)
    try {
      const result = await run(server.base, writer(3, 'stdout', 'Z'))
      expect(result.stdout).toBe('Z')
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('drains a stream far larger than the bound instead of blocking the command', async () => {
    const server = await bounded(1024)
    try {
      // 16 MiB 远超管道缓冲：容器若不再读这条流，写满管道后子进程会阻塞，这次请求永远不 settle。
      const result = await run(server.base, writer(16 * 1024 * 1024, 'stdout', 'TAIL'))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBe(1024)
      expect(result.stdout.endsWith('TAIL')).toBe(true)
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('bounds stderr by the same rule and reports it separately', async () => {
    const server = await bounded(512)
    try {
      const result = await run(server.base, writer(4096, 'stderr', 'TAIL'))
      expect(result.stdout).toBe('')
      expect(result.stdoutTruncated).toBeUndefined()
      expect(result.stderr).toBe(`${'x'.repeat(508)}TAIL`)
      expect(result.stderrTruncated).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('bounds bytes rather than characters on a multibyte stream', async () => {
    const server = await bounded(1000)
    try {
      // 2000 个「é」是 4000 字节：上界按字节算，所以保留的是 1000 字节而不是 1000 个字符。
      const result = await run(server.base, 'process.stdout.write(\'é\'.repeat(2000))')
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(1000)
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('bounds a stream while the command reads a relative path from the forwarded cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-exec-bound-'))
    writeFileSync(join(dir, 'marker.txt'), `${'x'.repeat(4096)}TAIL`)
    const server = await bounded(1024)
    try {
      // 文件按相对路径读：只有 cwd 真被转发这条命令才会成功，同时上界照常生效。
      const result = await run(server.base, "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))", { cwd: dir })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(`${'x'.repeat(1020)}TAIL`)
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds a stream while the command consumes all of stdin', async () => {
    const server = await bounded(1024)
    try {
      // 末尾是 stdin 收到的字节数：只有 stdin 完整送达、并且上界砍的是开头时，末尾才是 `|8`。
      const result = await run(
        server.base,
        "let received = ''; process.stdin.on('data', (chunk) => { received += chunk }); process.stdin.on('end', () => { process.stdout.write('x'.repeat(4096) + '|' + received.length) })",
        { stdin: 'piped-in' },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`${'x'.repeat(1022)}|8`)
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('bounds a stream while the command uses both a forwarded cwd and stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-exec-bound-both-'))
    writeFileSync(join(dir, 'marker.txt'), 'from-cwd')
    // 输出是 8 字节的 cwd 内容接 8 字节的 stdin，恰好 16 字节：保留末尾 8 字节就是整个 stdin。
    // cwd 没转发时 readFileSync 抛错、退出码非 0；stdin 丢了则输出恰好 8 字节而不报截断。
    const server = await bounded(8)
    try {
      const result = await run(
        server.base,
        "let received = ''; process.stdin.on('data', (chunk) => { received += chunk }); process.stdin.on('end', () => { process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8') + received) })",
        { cwd: dir, stdin: 'piped-in' },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe('piped-in')
      expect(result.stdoutTruncated).toBe(true)
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies no bound when none is configured', async () => {
    const server = await bounded(undefined)
    try {
      const result = await run(server.base, writer(512 * 1024, 'stdout', 'TAIL'))
      expect(result.stdout.length).toBe(512 * 1024 + 4)
      expect(result.stdoutTruncated).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})

/** 等一段时间，让真实的计时器有机会跑。 */
function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 空闲 watchdog：容器自己判定「有没有人用」，因为每个请求都要到达容器。
 * 退出通道是注入的，所以这些用例断言的是判定结果，不是真把测试进程关掉。
 */
describe('tool-exec idle watchdog', () => {
  /** 起一个带预算的服务器，并把每次退出记下来。 */
  async function watchdog(
    options: { idleTimeoutMs?: number; idleCheckMs?: number },
  ): Promise<{ running: ListeningToolExecServer; exits: number[] }> {
    const exits: number[] = []
    const running = await listenToolExecServer(0, '127.0.0.1', {
      ...options,
      exit: (code) => { exits.push(code) },
    })
    return { running, exits }
  }

  /** 关掉一个监听中的服务器，等它真的关完。 */
  async function close(running: ListeningToolExecServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      running.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }

  it('exits once the idle budget passes with nothing in flight', async () => {
    const { running, exits } = await watchdog({ idleTimeoutMs: 30, idleCheckMs: 5 })
    try {
      await settle(80)
      expect(exits).toEqual([0])
    } finally {
      await close(running)
    }
  })

  it('never exits when no budget is configured', async () => {
    const { running, exits } = await watchdog({})
    try {
      await settle(80)
      expect(exits).toEqual([])
    } finally {
      await close(running)
    }
  })

  it('does not exit while a command is still running, then exits after it ends', async () => {
    const { running, exits } = await watchdog({ idleTimeoutMs: 30, idleCheckMs: 5 })
    try {
      const call = fetch(`http://127.0.0.1:${running.port}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 用 Node 自己当那条长命令：这套测试要能在没有 sh 的宿主上跑。
        body: JSON.stringify({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 250)'] }),
      })
      await settle(150)
      // 这条命令跑了 250ms，远超 30ms 的预算：正在执行的命令不是「没人派任务」。
      expect(exits).toEqual([])
      await call
      await settle(80)
      // 命令结束之后，计时才重新开始，预算到点才退出。
      expect(exits).toEqual([0])
    } finally {
      await close(running)
    }
  })

  it('pushes the deadline back when a request arrives', async () => {
    const { running, exits } = await watchdog({ idleTimeoutMs: 60, idleCheckMs: 5 })
    try {
      await settle(40)
      await fetch(`http://127.0.0.1:${running.port}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ argv: [process.execPath, '-e', '0'] }),
      })
      // 已经过了 40ms，若计时没有重新开始，这里早就到点了。
      await settle(40)
      expect(exits).toEqual([])
      await settle(80)
      expect(exits).toEqual([0])
    } finally {
      await close(running)
    }
  })
})
