/**
 * Minimal MCP server over stdio for e2e testing of the dsh-mcp-client plugin.
 * Registers controlled tools with predictable behavior for asserting edge cases.
 *
 * Run: node fixture-server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'fixture-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.registerTool('add', {
  title: 'Add Tool',
  description: 'Adds two numbers.',
  inputSchema: { a: z.number().describe('First number'), b: z.number().describe('Second number') },
}, async args => ({
  content: [{ type: 'text', text: String(args.a + args.b) }],
}))

server.registerTool('greet', {
  title: 'Greet Tool',
  description: 'Greets a person by name.',
  inputSchema: { name: z.string().describe('Name to greet') },
}, async args => ({
  content: [{ type: 'text', text: `Hello, ${args.name}!` }],
}))

server.registerTool('fail', {
  title: 'Fail Tool',
  description: 'Always returns an error.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'Something went wrong' }],
  isError: true,
}))

server.registerTool('image', {
  title: 'Image Tool',
  description: 'Returns an image content block.',
  inputSchema: {},
}, async () => ({
  content: [
    { type: 'text', text: 'Here is an image:' },
    { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', mimeType: 'image/png' },
    { type: 'text', text: 'End of image.' },
  ],
}))

server.registerTool('crash', {
  title: 'Crash Tool',
  description: 'Replies, then exits the server process (crash-recovery test).',
  inputSchema: {},
}, async () => {
  // Exit AFTER the response flushes so the caller observes a clean result
  // followed by a transport close, like a real post-reply crash.
  setTimeout(() => process.exit(7), 25)
  return { content: [{ type: 'text', text: 'crashing' }] }
})

// Dotted name: legal in MCP, illegal in the DeepSeek function-name contract.
// Exercises the bridge's normalize-and-hash public-name path end to end.
server.registerTool('admin.reset', {
  title: 'Admin Reset Tool',
  description: 'Tool with a dotted name (normalization test).',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'reset done' }],
}))

/**
 * Peak number of `slow_read` handlers this process has run at the same time.
 * A concurrency test reads it back through `concurrency_stats`, so the
 * assertion measures the server's own observed overlap rather than the
 * client's bookkeeping.
 */
let peakInFlight = 0
let inFlight = 0

server.registerTool('slow_read', {
  title: 'Slow Read Tool',
  description: 'Holds a read open, so overlapping calls are observable.',
  inputSchema: { tag: z.string().describe('Tag echoed back'), holdMs: z.number().describe('How long to hold') },
  annotations: { readOnlyHint: true },
}, async (args) => {
  inFlight += 1
  peakInFlight = Math.max(peakInFlight, inFlight)
  await new Promise(resolve => setTimeout(resolve, args.holdMs))
  inFlight -= 1
  return { content: [{ type: 'text', text: `read:${args.tag}` }] }
})

server.registerTool('concurrency_stats', {
  title: 'Concurrency Stats Tool',
  description: 'Reports the peak concurrent slow_read handlers.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => ({
  content: [{ type: 'text', text: String(peakInFlight) }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
