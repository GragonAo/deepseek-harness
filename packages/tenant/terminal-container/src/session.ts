/** 容器后端的一个活着的 PTY 会话：沙箱里的交互式 shell、有界回滚缓冲、发送就绪判定。 */

import { Buffer } from 'node:buffer'
import type { ContainerPtyForeground, ContainerPtySession } from '@deepseek-ai/dsh-container'
import type {
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type { ResolvedConfig } from './config.ts'

/* jscpd:ignore-start -- 有界缓冲与分页这段与 terminal-bash/src/session.ts 是有意的镜像：
   分页语义属于终端接缝本身，两个后端必须逐字给出同一个答案，而调用方（tool-terminal、
   tool-bash-persistent）读的正是这个答案。抽到共享位置的唯一去处是接缝自己那个包，
   那不在本包手里。这段一旦改动，两处必须一起改。 */
function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

/** 行数与字节数双上界的回滚缓冲；丢掉的旧输出会被记下，而不是悄悄消失。 */
class BoundedScrollback {
  private value = ''
  private dropped = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number,
  ) {}

  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    const lines = this.value.split('\n')
    if (lines.length > this.maxLines) {
      this.value = lines.slice(lines.length - this.maxLines).join('\n')
      this.dropped = true
    }
    const tail = utf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }
}
/* jscpd:ignore-end */

/** 一次仍在进行的发送：只读它自己那段增量，并在会话给出证据时结算。 */
class SendOperation implements TerminalSendOperation {
  /** 开始时刻，用于绝对期限。 */
  readonly startedAt = Date.now()
  readonly done: Promise<TerminalSendResult>

  private delta = ''
  private dropped = false
  private result: TerminalSendResult | undefined
  private failed = false
  /** 是否已经问过前台进程组；每次发送最多问一次。 */
  private probed = false
  private readonly settle: (result: TerminalSendResult) => void
  private readonly reject: (error: unknown) => void

  /**
   * @param interrupt - 交付一次 `SIGINT` 的方式。
   */
  constructor(private readonly interrupt: () => Promise<number>) {
    const settled = Promise.withResolvers<TerminalSendResult>()
    this.done = settled.promise
    this.settle = settled.resolve
    this.reject = settled.reject
  }

  /** 这次发送是否已经有结论（结算或失败）。 */
  get settled(): boolean {
    return this.result !== undefined || this.failed
  }

  /** 这次发送是否已经问过前台进程组。 */
  get asked(): boolean {
    return this.probed
  }

  /** 记下已经问过前台进程组。 */
  ask(): void {
    this.probed = true
  }

  /**
   * 收下本次发送期间到达的输出。
   * @param delta - 新到的输出。
   * @param truncated - 容器侧是否已经丢过更早的输出。
   * @param maxBytes - 本次操作保留输出的字节上界。
   */
  accept(delta: string, truncated: boolean, maxBytes: number): void {
    this.delta += delta
    const bounded = utf8Tail(this.delta, maxBytes)
    this.delta = bounded.text
    this.dropped ||= truncated || bounded.truncated
  }

  readOutput(): TerminalSendRead {
    const delta = this.delta
    const truncated = this.dropped
    this.delta = ''
    this.dropped = false
    return { delta, truncated }
  }

  cancel(): boolean {
    if (this.settled) return false
    // 中断是尽力而为：信号发不出去时这次发送仍由静默、期限或会话退出结算，
    // 而调用方要的是结果，不是一个它插不上手的中断失败。
    void this.interrupt().catch(() => undefined)
    return true
  }

  /**
   * 让这次发送以失败结束：会话已经不能再用时，把原因交给调用方，而不是让它等到期限。
   * 拒绝和结算一样都是「这次发送有结论了」，所以两者共用一个 settled 判断。
   * @param error - 失败原因。
   */
  fail(error: unknown): void {
    if (this.settled) return
    this.failed = true
    this.reject(error)
  }

  /**
   * 给出这次发送的结果，并保留尚未被取走的增量作为视图。
   * @param waitReason - 为什么等待返回。
   * @param status - 结算时观察到的顶层状态。
   * @param sessionTruncated - 回滚缓冲是否丢过更早的输出。
   */
  complete(waitReason: TerminalWaitReason, status: TerminalSessionStatus, sessionTruncated: boolean): void {
    if (this.settled) return
    this.result = {
      viewport: this.delta,
      waitReason,
      sessionStatus: status,
      truncated: this.dropped || sessionTruncated,
    }
    this.settle(this.result)
  }
}

/** 容器后端发布的会话：它自己只做人这一侧的事，沙箱那一侧全在容器运行时手里。 */
export class ContainerTerminalSession implements TerminalBackendSession {
  /** 建立会话时已经到手的启动输出，去掉握手噪声之后的那一段。 */
  motd = ''
  /** 容器里的顶层进程号；沙箱内的编号只在本会话里有意义。 */
  readonly pid: number

  private readonly scrollback: BoundedScrollback
  private active: SendOperation | undefined
  private timer: NodeJS.Timeout | undefined
  private closing = false
  private closePromise: Promise<void> | undefined
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  private lastOutputAt = Date.now()

  /**
   * @param session - 容器运行时给出的那个交互式会话。
   * @param config - 已校验的配置。
   */
  constructor(
    private readonly session: ContainerPtySession,
    private readonly config: ResolvedConfig,
  ) {
    this.scrollback = new BoundedScrollback(config.scrollbackMaxBytes, config.scrollbackLines)
    this.pid = session.pid
    void session.done.then((outcome) => {
      this.statusValue = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
      // 静下来是会话退出的后果：还挂着的发送以 session_exit 结算，而不是等到期限。
      this.settleActive('session_exit')
    })
  }

  /** 取走建立会话时已经到手的输出，并开始观察容器那边的新输出。 */
  initialize(): void {
    const read = this.session.read()
    if (read.data.length > 0) {
      this.scrollback.append(read.data)
      this.motd = utf8Tail(read.data, this.config.readMaxBytes).text
    }
    this.lastOutputAt = Date.now()
    this.schedule()
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error('terminal-container: PTY session is closing')
    if (this.active !== undefined) throw new Error('terminal-container: PTY session already has an active send')
    const operation = new SendOperation(() => this.session.signal('SIGINT'))
    if (this.statusValue.kind === 'exited') {
      // 会话已经结束：立刻给出一个已结算的操作，调用方不必等一个不会到来的输出。
      operation.complete('session_exit', this.statusValue, this.scrollback.snapshot().truncated)
      return operation
    }
    this.active = operation
    if (request.signal !== undefined) {
      const onAbort = (): void => {
        operation.cancel()
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      void operation.done.then(() => request.signal?.removeEventListener('abort', onAbort))
    }
    const text = request.submit ? `${request.text}\n` : request.text
    if (text.length > 0) {
      void this.session.write(text).catch((error: unknown) => {
        if (this.active !== operation) return
        this.active = undefined
        operation.fail(error)
      })
    }
    return operation
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('terminal-container: read offset must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error('terminal-container: read count must be a positive safe integer')
    }
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const bounded = utf8Tail(lines.slice(start, end).join('\n'), this.config.readMaxBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error('terminal-container: PTY session is closing')
    const targetPgid = await this.session.signal(signal)
    return { delivered: true, targetPgid }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      // 关不掉的会话可以重试：调用方可能在沙箱回来之后再关一次，而被记住的拒绝会让它无从重来。
      this.closePromise = undefined
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private async closeOnce(reason: string): Promise<void> {
    this.stopObserving()
    try {
      await this.session.close(reason)
    } catch (error: unknown) {
      throw new Error(`terminal-container: closing the container terminal failed (${reason})`, { cause: error })
    }
    // 静下来是这次关闭的结局：还挂着的发送以 session_exit 结算。
    this.settleActive('session_exit')
  }

  private stopObserving(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.timer !== undefined || this.closing) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.observe()
    }, this.config.pollIntervalMs)
    // 观察计时器不代表还有工作：它不该把宿主进程留在事件循环里。
    this.timer.unref()
  }

  private observe(): void {
    const read = this.session.read()
    if (read.data.length > 0) {
      this.lastOutputAt = Date.now()
      this.scrollback.append(read.data)
      this.active?.accept(read.data, read.truncated, this.config.readMaxBytes)
    }
    const operation = this.active
    if (operation !== undefined && !this.closing) void this.checkReadiness(operation)
    this.schedule()
  }

  /**
   * 判断这次发送能不能给出结果。
   *
   * 证据只有两样：会话退出了，或者终端静下来了。静下来之后还要问一次沙箱里的前台进程组，
   * 因为「静」既可能是对方在等输入，也可能是命令还在跑而不吭声；容器侧给不出内核级的
   * 「正在读 stdin」事实，所以只要还有活着的进程组就按等输入结算（`tool-bash-persistent`
   * 的契约里，「前台进程组在读」正是 prompt 之外的另一种等输入），一个活的进程组都没有才退回
   * `inferred_idle`。这次询问同时是一次存活探测：问不通就不结算，让会话退出或绝对期限来收尾。
   * @param operation - 当前这次发送。
   */
  private async checkReadiness(operation: SendOperation): Promise<void> {
    if (this.active !== operation) return
    if (this.statusValue.kind === 'exited') {
      this.settleActive('session_exit')
      return
    }
    if (Date.now() - operation.startedAt >= this.config.timeoutMs) {
      this.settleActive('timeout')
      return
    }
    if (operation.asked) return
    if (Date.now() - this.lastOutputAt < this.config.idleSilenceMs) return
    // 每次发送只问一次：一直问下去会在沙箱不可达时变成一轮轮徒劳的往返。
    operation.ask()
    let foreground: ContainerPtyForeground | undefined
    try {
      foreground = await this.session.foreground()
    } catch (_probeFailed) {
      // 沙箱答不上话时不结算：会话真的消失了会以 session_exit 结算这次发送，
      // 否则由绝对期限兜底。在这里猜一个理由，等于把「沙箱不可达」说成「终端空闲」。
      return
    }
    if (this.active !== operation) return
    this.settleActive(foreground === undefined ? 'inferred_idle' : 'stdin_read')
  }

  private settleActive(waitReason: TerminalWaitReason): void {
    const operation = this.active
    if (operation === undefined) return
    this.active = undefined
    operation.complete(waitReason, this.statusValue, this.scrollback.snapshot().truncated)
  }
}
