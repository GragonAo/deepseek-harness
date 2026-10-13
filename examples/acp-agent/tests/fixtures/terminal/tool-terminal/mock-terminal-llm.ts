/**
 * Scripted model for the tool-terminal fixture: opens a terminal, writes one
 * line through `terminal_send`, reads the retained output back, and answers with
 * the text it read. Every step is a real tool call through the assembled
 * registry, so the fixture proves the terminal tools execute end to end.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

const MARKER = 'loader-terminal-ok'

/** Text of every tool result the model has seen so far, in order. */
function toolResults(options: GenerateOptions): string[] {
  return options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'tool-result')
    .map(block => block.content.filter(part => part.type === 'text').map(part => part.text).join(''))
}

/** The session id `terminal_open` reported, which later calls must reuse. */
function openedSessionId(results: readonly string[]): string {
  const match = /started terminal session (\S+)/.exec(results[0] ?? '')
  if (match?.[1] === undefined) throw new Error(`terminal_open reported no session id: ${results[0] ?? '(no result)'}`)
  return match[1]
}

class MockTerminalAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = toolResults(options)
    const step = results.length

    if (step === 0) {
      yield* this.call('terminal-open', 'terminal_open', { type: 'shell', cwd: '.' })
      return
    }
    if (step === 1) {
      yield* this.call('terminal-send', 'terminal_send', { sessionId: openedSessionId(results), text: MARKER })
      return
    }
    if (step === 2) {
      yield* this.call('terminal-read', 'terminal_read', { sessionId: openedSessionId(results) })
      return
    }

    const reply = `terminal read back:\n${results.at(-1) ?? ''}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: reply.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private async * call(id: string, name: string, args: Record<string, unknown>): AsyncIterable<StreamChunk> {
    const arguments_ = JSON.stringify(args)
    const callId = CallId(id)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: arguments_ }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: arguments_ } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']

/**
 * Register the scripted terminal adapter under the `mock` provider.
 * @param ctx - the plugin context supplying `ctx.llm`.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new MockTerminalAdapter())
}
