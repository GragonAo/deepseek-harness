/**
 * Container runtime for the tool-terminal Loader fixture. The sandbox is an
 * external service, so this fake records each PTY request and answers it with a
 * scripted shell that echoes every write back — enough for the composition to
 * boot and for a terminal round trip to settle without a container backend.
 */

import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type {
  ContainerCommandResult,
  ContainerPtyOptions,
  ContainerPtyOutcome,
  ContainerPtyRead,
  ContainerPtySession,
} from '@deepseek-ai/dsh-container'

/** The interactive session the sandbox would own; the driver reads what it wrote. */
class FakePty implements ContainerPtySession {
  readonly pid = 1

  readonly done: Promise<ContainerPtyOutcome>

  private settleDone!: (outcome: ContainerPtyOutcome) => void

  private output = ''

  constructor() {
    this.done = new Promise((resolve) => { this.settleDone = resolve })
  }

  read(): ContainerPtyRead {
    const data = this.output
    this.output = ''
    return { data, truncated: false }
  }

  async write(data: string): Promise<void> {
    this.output += data
  }

  async foreground(): Promise<{ pgid: number } | undefined> {
    return { pgid: this.pid }
  }

  async signal(): Promise<number> {
    return this.pid
  }

  async close(): Promise<void> {
    this.settleDone({ exitCode: 0, signal: null })
  }
}

/** The runtime the fixture installs in place of a docker or k8s backend. */
export default class FakeContainerRuntime extends ContainerRuntime {
  /** PTY requests the composition made, in order. */
  readonly opens: ContainerPtyOptions[] = []

  async exec(): Promise<ContainerCommandResult> {
    throw new Error('FakeContainerRuntime: the terminal backend never runs a one-shot exec')
  }

  async openPty(options: ContainerPtyOptions): Promise<ContainerPtySession> {
    this.opens.push(options)
    return new FakePty()
  }
}
