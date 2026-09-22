/**
 * Swagger UI route pair served by the agent-http carrier when a `webServer` is
 * present: `GET /openapi.json` (the generated OpenAPI 3.1 document) and the
 * `/swagger` prefix (the Swagger UI shell plus its vendored static assets).
 * These routes answer without bearer auth — they describe the surface an
 * integrator authenticates against, so the document is public discovery, not
 * tenant data.
 *
 * The Swagger UI bundle is read at first request from `swagger-ui-dist` (a
 * regular dependency, so it lists in the package manifest and resolves from the
 * same node_modules as the runtime), then cached.
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { generateOpenApiDocument } from '@deepseek-ai/dsh-host-apiproxy'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

const nodeRequire = createRequire(import.meta.url)

const SWAGGER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepSeek Harness API</title>
  <link rel="stylesheet" href="/swagger/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger/swagger-ui-bundle.js"></script>
  <script src="/swagger/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
      })
    }
  </script>
</body>
</html>
`

interface StaticAsset {
  content: Buffer
  type: string
}

/** Swagger UI static files served under the `/swagger` prefix, keyed by pathname. */
const ASSET_KEYS: Record<string, { specifier: string; type: string }> = {
  '/swagger/swagger-ui.css': { specifier: 'swagger-ui-dist/swagger-ui.css', type: 'text/css; charset=utf-8' },
  '/swagger/swagger-ui-bundle.js': { specifier: 'swagger-ui-dist/swagger-ui-bundle.js', type: 'application/javascript; charset=utf-8' },
  '/swagger/swagger-ui-standalone-preset.js': { specifier: 'swagger-ui-dist/swagger-ui-standalone-preset.js', type: 'application/javascript; charset=utf-8' },
}

let assetCache: Record<string, StaticAsset> | undefined
let documentBody: string | undefined

/** Resolve, read, and cache the Swagger UI static bundle at first request. */
function swaggerAssets(): Record<string, StaticAsset> {
  if (assetCache !== undefined) return assetCache
  const packageRoot = dirname(nodeRequire.resolve('swagger-ui-dist'))
  assetCache = {}
  for (const [pathname, entry] of Object.entries(ASSET_KEYS)) {
    const file = join(packageRoot, entry.specifier.split('/').at(-1) ?? entry.specifier)
    assetCache[pathname] = { content: readFileSync(file), type: entry.type }
  }
  return assetCache
}

/** The generated OpenAPI document, serialized once. */
function openApiBody(): string {
  if (documentBody === undefined) documentBody = JSON.stringify(generateOpenApiDocument())
  return documentBody
}

function json(response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(body)
}

/** Serve the Swagger UI shell or one of its static assets. */
function swaggerHandler(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }
  const pathname = (request.url ?? '/').split('?')[0] ?? '/'
  if (pathname === '/swagger' || pathname === '/swagger/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(SWAGGER_HTML)
    return
  }
  const asset = swaggerAssets()[pathname]
  if (asset === undefined) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': asset.type })
  response.end(asset.content)
}

/**
 * The two routes this carrier contributes for API discovery.
 * @returns the `/swagger` prefix route (shell + assets) and the `/openapi.json` exact route.
 */
export function swaggerRoutes(): WebRoute[] {
  return [
    { kind: 'exact', path: '/openapi.json', handler: (_request, response) => { json(response, openApiBody()) } },
    { kind: 'prefix', path: '/swagger', handler: swaggerHandler },
  ]
}
