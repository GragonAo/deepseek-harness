#!/usr/bin/env node
/**
 * Test driver: boot the tool-terminal Loader composition and drive one real
 * agent turn whose scripted model opens a terminal, writes one marker line,
 * reads the retained output back, and answers with it. The report carries the
 * assembled tool surface, the tool calls the registry actually executed, and
 * the text the terminal read back.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('tool-terminal driver requires a config path')

const TERMINAL_TOOLS = ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_close'] as const

interface TerminalLoaderReport {
  toolNames: string[]
  missingTools: string[]
  calls: string[]
  results: string[]
  output: string
  turnSettled: boolean
}

const ctx = await boot('tool-terminal-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const names = ctx.tools.schemas().map(tool => tool.name)
  const calls: string[] = []
  const results: string[] = []
  // Bounded well inside the smoke harness's process timeout, and traced on
  // stdout: a stalled turn must name the step it reached rather than time out
  // blind.
  const turn = await Promise.race([
    runFixtureTurn(ctx, {
      task: '建立终端会话，写一行字，把输出读回来。',
      onEvent: (_sessionId, event) => {
        if (event.type === 'tool/call') {
          calls.push(event.data.name)
          // On stdout so a stalled turn names the step it reached; the smoke
          // harness echoes stdout when the process fails.
          console.log(`call ${event.data.name}`)
        }
        // Serialized rather than read block-by-block: the assertion only needs the
        // text the tool reported, and this survives any content-block split.
        if (event.type === 'tool/result') results.push(JSON.stringify(event.data))
      },
    }),
    new Promise<null>(resolve => setTimeout(() => { resolve(null) }, 10_000)),
  ])
  console.log(`turnSettled ${String(turn !== null)}`)
  await writeFile('./terminal-loader-report.json', JSON.stringify({
    toolNames: TERMINAL_TOOLS.filter(name => names.includes(name)),
    missingTools: TERMINAL_TOOLS.filter(name => !names.includes(name)),
    calls,
    results,
    output: turn?.output ?? '',
    turnSettled: turn !== null,
  } satisfies TerminalLoaderReport))
} finally {
  await ctx.fiber.dispose()
}
