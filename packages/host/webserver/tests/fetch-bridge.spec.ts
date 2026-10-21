/**
 * Fake-object coverage for the node:http ↔ fetch adapter, whose real-socket
 * behavior the Loader composition suite cannot drive deterministically: the
 * body cap on both the declared and the streaming path, response copying, the
 * backpressure wait, and client-close aborts.
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { bridgeFetchRequest } from '../src/fetch-bridge.ts'

/** The request fields the adapter reads. */
interface RequestOptions {
  /** Body chunks the request yields, in order. */
  chunks?: Buffer[]
  /** Request headers. */
  headers?: Record<string, string>
  /** Request url, absolute-path form as node sets it. */
  url?: string
  /** Request method. */
  method?: string
}

/** A request stand-in plus how often the adapter destroyed it. */
interface FakeRequest {
  request: IncomingMessage
  /** Number of `destroy()` calls, the abort the body cap promises. */
  destroys: number
}

/**
 * Build the request stand-in: an async iterable over body chunks with the
 * headers, url, and method the adapter copies into the Fetch request.
 * @param options - body chunks, headers, url, and method.
 * @returns the stand-in request and its destroy counter.
 */
function fakeRequest(options: RequestOptions = {}): FakeRequest {
  const fake: FakeRequest = { request: undefined as unknown as IncomingMessage, destroys: 0 }
  fake.request = {
    headers: options.headers ?? {},
    url: options.url ?? '/api/probe',
    method: options.method ?? 'POST',
    destroy: () => { fake.destroys += 1 },
    async *[Symbol.asyncIterator]() {
      for (const chunk of options.chunks ?? []) yield chunk
    },
  } as unknown as IncomingMessage
  return fake
}

/** A response stand-in with everything the adapter is expected to write. */
interface RecordedResponse {
  response: ServerResponse
  /** Status passed to `writeHead`, if any. */
  status: number | undefined
  /** Headers passed to `writeHead`, if any. */
  headers: Record<string, string> | undefined
  /** Body chunks the adapter wrote, in order. */
  chunks: Uint8Array[]
  /** Ordering of `write`/`drain`/`end`, which shows whether a write waited. */
  events: string[]
  /** Whether the adapter ended the response. */
  ended: boolean
  /** Emit the connection teardown node fires when the client goes away. */
  disconnect: () => void
}

/**
 * Build the response stand-in. The first `write` reports a full socket buffer
 * and the next tick emits `drain`, so a streamed body runs the backpressure
 * wait; `events` records the ordering that wait produces.
 * @returns the recorder.
 */
function recordResponse(): RecordedResponse {
  const emitter = new EventEmitter()
  const recorded: RecordedResponse = {
    response: undefined as unknown as ServerResponse,
    status: undefined,
    headers: undefined,
    chunks: [],
    events: [],
    ended: false,
    disconnect: () => { emitter.emit('close') },
  }
  let writes = 0
  const response = Object.assign(emitter, {
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string>): void {
      recorded.status = status
      recorded.headers = headers
    },
    write(chunk: Uint8Array): boolean {
      recorded.chunks.push(chunk)
      recorded.events.push('write')
      writes += 1
      if (writes > 1) return true
      setImmediate(() => {
        recorded.events.push('drain')
        emitter.emit('drain')
      })
      return false
    },
    end(this: { writableEnded: boolean }): void {
      recorded.ended = true
      recorded.events.push('end')
      this.writableEnded = true
    },
  })
  recorded.response = response as unknown as ServerResponse
  return recorded
}

/**
 * Build a response whose body arrives as the given chunks.
 * @param chunks - body text pieces delivered one per read.
 * @returns the streaming response.
 */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200 })
}

describe('bridgeFetchRequest', () => {
  it('answers 413 and destroys a request whose declared length is over the cap', async () => {
    const fake = fakeRequest({
      chunks: [Buffer.from('{}')],
      headers: { 'content-length': '999999' },
    })
    const recorded = recordResponse()
    let dispatched = false

    await bridgeFetchRequest(fake.request, recorded.response, {
      fetch: async () => {
        dispatched = true
        return new Response(null, { status: 204 })
      },
    }, 1000)

    expect(recorded.status).toBe(413)
    expect(recorded.headers).toEqual({ connection: 'close' })
    expect(recorded.chunks).toHaveLength(0)
    expect(recorded.ended).toBe(true)
    expect(fake.destroys).toBe(1)
    expect(dispatched).toBe(false)
  })

  it('answers 413 and destroys a request that crosses the cap while streaming', async () => {
    const fake = fakeRequest({ chunks: [Buffer.alloc(8), Buffer.alloc(8)] })
    const recorded = recordResponse()
    let dispatched = false

    await bridgeFetchRequest(fake.request, recorded.response, {
      fetch: async () => {
        dispatched = true
        return new Response(null, { status: 204 })
      },
    }, 10)

    expect(recorded.status).toBe(413)
    expect(recorded.headers).toEqual({ connection: 'close' })
    expect(recorded.chunks).toHaveLength(0)
    expect(recorded.ended).toBe(true)
    expect(fake.destroys).toBe(1)
    expect(dispatched).toBe(false)
  })

  it('copies the handler status and headers and writes its body', async () => {
    const body = '{"type":"client-request"}'
    const fake = fakeRequest({
      chunks: [Buffer.from(body.slice(0, 9)), Buffer.from(body.slice(9))],
      headers: { 'content-type': 'application/json', 'x-probe': 42 } as unknown as Record<string, string>,
      url: '/api/session.prompt',
      method: 'POST',
    })
    const recorded = recordResponse()
    let received: Request | undefined

    // No cap argument: the exported default bounds the body.
    await bridgeFetchRequest(fake.request, recorded.response, {
      fetch: async (incoming) => {
        received = incoming
        return new Response('{"ok":true}', {
          status: 201,
          headers: { 'content-type': 'application/json', 'x-answered': 'yes' },
        })
      },
    })

    expect(received?.url).toBe('http://dsh.internal/api/session.prompt')
    expect(received?.method).toBe('POST')
    // Non-string header values are dropped rather than stringified.
    expect(received?.headers.get('content-type')).toBe('application/json')
    expect(received?.headers.get('x-probe')).toBeNull()
    expect(await received?.text()).toBe(body)
    expect(received?.signal.aborted).toBe(false)
    expect(recorded.status).toBe(201)
    expect(recorded.headers).toMatchObject({ 'content-type': 'application/json', 'x-answered': 'yes' })
    expect(Buffer.concat(recorded.chunks).toString()).toBe('{"ok":true}')
    expect(recorded.ended).toBe(true)
    expect(fake.destroys).toBe(0)
  })

  it('ends the response without a write when the handler returns no body', async () => {
    const fake = fakeRequest()
    const recorded = recordResponse()

    await bridgeFetchRequest(fake.request, recorded.response, {
      fetch: async () => new Response(null, { status: 204 }),
    }, 1000)

    expect(recorded.status).toBe(204)
    expect(recorded.chunks).toHaveLength(0)
    expect(recorded.events).toEqual(['end'])
    expect(recorded.ended).toBe(true)
  })

  it('waits for drain after a false write, then streams the rest', async () => {
    const fake = fakeRequest()
    const recorded = recordResponse()

    await bridgeFetchRequest(fake.request, recorded.response, {
      fetch: async () => streamingResponse(['one', 'two', 'three']),
    }, 1000)

    expect(recorded.chunks.map(chunk => Buffer.from(chunk).toString())).toEqual(['one', 'two', 'three'])
    // The second and third writes land only after the full socket buffer
    // reported by the first one drained.
    expect(recorded.events).toEqual(['write', 'drain', 'write', 'write', 'end'])
  })

  it('leaves the handler signal alone when the connection closes after the response ended', async () => {
    const fake = fakeRequest()
    const recorded = recordResponse()
    let received: Request | undefined

    await bridgeFetchRequest(fake.request, recorded.response, {
      fetch: async (incoming) => {
        received = incoming
        return Response.json({ ok: true })
      },
    }, 1000)

    expect(recorded.ended).toBe(true)
    // A normal end() followed by the connection going away is not a disconnect.
    recorded.disconnect()
    expect(received?.signal.aborted).toBe(false)
  })

  it('aborts the handler signal when the client disconnects before the response ends', async () => {
    const fake = fakeRequest()
    const recorded = recordResponse()
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let abortedInsideHandler: boolean | undefined

    const pending = bridgeFetchRequest(fake.request, recorded.response, {
      fetch: async (incoming) => {
        resolveStarted()
        if (!incoming.signal.aborted) {
          await new Promise<void>((resolve) => {
            incoming.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        abortedInsideHandler = incoming.signal.aborted
        return new Response('late', { status: 200 })
      },
    }, 1000)

    await started
    recorded.disconnect()
    await pending

    expect(abortedInsideHandler).toBe(true)
  })
})
