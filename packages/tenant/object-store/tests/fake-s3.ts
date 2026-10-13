import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'

/** 一个最小的 S3 兼容服务：够 PUT / HEAD / DELETE 对象级请求用。 */
export interface FakeS3 {
  /** 端点源（`http://127.0.0.1:port`）。 */
  readonly origin: string
  /** 已写入的对象，键到字节。 */
  readonly objects: Map<string, Uint8Array>
  /** 收到过的 `Authorization` 请求头，按到达顺序。 */
  readonly authorizations: string[]
  /** 是否允许不带凭据的读；置 `false` 用来验证「公开性真的被校验」。 */
  publicRead: boolean
  /** 关掉服务。 */
  close(): Promise<void>
}

/**
 * 起一个假 S3。
 * @param options - 匿名读开关与拒写开关。
 * @returns 服务句柄。
 */
export async function startFakeS3(options: { publicRead?: boolean; refuseWrites?: boolean } = {}): Promise<FakeS3> {
  const objects = new Map<string, Uint8Array>()
  const authorizations: string[] = []
  const server: Server = createServer((request, response) => {
    void handle(request, response, objects, authorizations, state)
  })
  const state = { publicRead: options.publicRead ?? true, refuseWrites: options.refuseWrites ?? false }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake S3 did not bind a TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    objects,
    authorizations,
    get publicRead() { return state.publicRead },
    set publicRead(value: boolean) { state.publicRead = value },
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}

/**
 * 处理一条请求。
 * @param request - 到达的请求。
 * @param response - 要写的响应。
 * @param objects - 对象表。
 * @param authorizations - 记录到的签名头。
 * @param state - 匿名读开关。
 */
async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  objects: Map<string, Uint8Array>,
  authorizations: string[],
  state: { publicRead: boolean; refuseWrites: boolean },
): Promise<void> {
  const signed = request.headers.authorization !== undefined
  if (signed) authorizations.push(String(request.headers.authorization))
  const path = new URL(request.url ?? '/', 'http://fake').pathname
  const key = path.split('/').slice(2).map(decodeURIComponent).join('/')
  if (key === '') {
    response.writeHead(404).end()
    return
  }
  if (request.method === 'PUT') {
    if (!signed) {
      response.writeHead(403).end('SignatureDoesNotMatch')
      return
    }
    if (state.refuseWrites) {
      response.writeHead(500).end('InternalError')
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    objects.set(key, new Uint8Array(Buffer.concat(chunks)))
    response.writeHead(200).end()
    return
  }
  if (request.method === 'HEAD') {
    if (!signed && !state.publicRead) {
      response.writeHead(403).end()
      return
    }
    const body = objects.get(key)
    if (body === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-length': String(body.byteLength) }).end()
    return
  }
  if (request.method === 'DELETE') {
    if (!signed) {
      response.writeHead(403).end()
      return
    }
    objects.delete(key)
    response.writeHead(204).end()
    return
  }
  response.writeHead(405).end()
}
