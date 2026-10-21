/**
 * node:http ↔ fetch adapter for the `/api` transport, exported under this
 * package's `bridge` name. The implementation lives in
 * `@deepseek-ai/dsh-host-webserver` — the package that owns node:http serving
 * and the `WebRoute` the adapter feeds — so every carrier shares one copy.
 */

export { bridgeFetchRequest as bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from '@deepseek-ai/dsh-host-webserver'
export type { FetchHandler } from '@deepseek-ai/dsh-host-webserver'
