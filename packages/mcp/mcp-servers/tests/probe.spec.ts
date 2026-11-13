/**
 * The draft-row probe: an endpoint that speaks MCP is reported with its tool
 * count, an endpoint that fails is reported as a failure rather than an
 * exception, the event-stream framing a Streamable HTTP server may answer in is
 * read, and a forbidden address is refused as a policy — not as an endpoint
 * answer, because nothing was asked.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeMcpServer } from '../src/probe.ts'

/** Servers to close after each test. */
const open: Server[] = []

/**
 * Start a one-endpoint MCP server.
 * @param handler - answers one request body with a body and status.
 * @returns the endpoint URL.
 */
async function listen(handler: (body: Record<string, unknown>, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      handler(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>, res)
    })
  })
  open.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}/mcp`
}

/**
 * Answer one JSON-RPC reply as plain JSON.
 * @param res - the response being answered.
 * @param payload - the JSON-RPC reply body.
 * @returns the response, so a handler can hand it straight back.
 */
function json(res: ServerResponse, payload: unknown): ServerResponse {
  res.writeHead(200, { 'content-type': 'application/json' })
  return res.end(JSON.stringify(payload))
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

describe('probeMcpServer', () => {
  it('reports the tool count of an endpoint that completes a handshake', async () => {
    const url = await listen((body, res) => {
      const method = body['method']
      if (method === 'initialize') {
        return json(res, { jsonrpc: '2.0', id: body['id'], result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })
      }
      if (method === 'tools/list') {
        return json(res, {
          jsonrpc: '2.0',
          id: body['id'],
          result: { tools: [{ name: 'search' }, { name: 'fetch' }] },
        })
      }
      res.writeHead(202).end()
    })
    const result = await probeMcpServer(url, {}, { allowPrivateHosts: true })
    expect(result).toMatchObject({ ok: true, toolsSupported: true, toolCount: 2 })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports an endpoint that declares no tool capability without listing tools', async () => {
    const url = await listen((body, res) => {
      if (body['method'] === 'initialize') {
        return json(res, { jsonrpc: '2.0', id: body['id'], result: { capabilities: {} } })
      }
      // A notification is answered with an empty 202 and no body.
      if (body['method'] === 'notifications/initialized') return res.writeHead(202).end()
      throw new Error('tools/list must not be sent to an endpoint without the capability')
    })
    expect(await probeMcpServer(url, {}, { allowPrivateHosts: true }))
      .toMatchObject({ ok: true, toolsSupported: false })
  })

  it('reads a reply framed as an event stream', async () => {
    const url = await listen((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (body['method'] === 'initialize') {
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { capabilities: { tools: {} } } })}\n\n`)
        return res.end()
      }
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { tools: [{ name: 'one' }] } })}\n\n`)
      return res.end()
    })
    expect(await probeMcpServer(url, {}, { allowPrivateHosts: true }))
      .toMatchObject({ ok: true, toolsSupported: true, toolCount: 1 })
  })

  it('follows a cursor to count every page of tools', async () => {
    const url = await listen((body, res) => {
      if (body['method'] === 'initialize') {
        return json(res, { jsonrpc: '2.0', id: body['id'], result: { capabilities: { tools: {} } } })
      }
      const cursor = (body['params'] as { cursor?: string } | undefined)?.cursor
      if (cursor === undefined) {
        return json(res, { jsonrpc: '2.0', id: body['id'], result: { tools: [{ name: 'a' }, { name: 'b' }], nextCursor: 'page-2' } })
      }
      return json(res, { jsonrpc: '2.0', id: body['id'], result: { tools: [{ name: 'c' }] } })
    })
    expect(await probeMcpServer(url, {}, { allowPrivateHosts: true }))
      .toMatchObject({ ok: true, toolCount: 3 })
  })

  it('reports a transport failure as a failed probe, not as a throw', async () => {
    const url = await listen((_body, res) => { res.writeHead(500, { 'content-type': 'text/plain' }).end('boom') })
    const result = await probeMcpServer(url, {}, { allowPrivateHosts: true })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })

  it('reports a JSON-RPC error the endpoint returns', async () => {
    const url = await listen((body, res) => json(res, { jsonrpc: '2.0', id: body['id'], error: { message: 'missing token' } }))
    const result = await probeMcpServer(url, {}, { allowPrivateHosts: true })
    expect(result).toMatchObject({ ok: false, error: 'missing token' })
  })

  it('refuses a forbidden address before opening a connection', async () => {
    await expect(probeMcpServer('http://127.0.0.1:9/mcp', {}, { allowPrivateHosts: false }))
      .rejects.toThrow(/loopback|private/iu)
    await expect(probeMcpServer('http://10.1.2.3/mcp', {}, { allowPrivateHosts: false }))
      .rejects.toThrow(/10\.1\.2\.3/u)
  })

  it('refuses a non-http scheme and a malformed URL', async () => {
    await expect(probeMcpServer('ftp://example.com/mcp', {}, { allowPrivateHosts: true }))
      .rejects.toThrow(/http/iu)
    await expect(probeMcpServer('not-a-url', {}, { allowPrivateHosts: true }))
      .rejects.toThrow(/URL/u)
  })
})
