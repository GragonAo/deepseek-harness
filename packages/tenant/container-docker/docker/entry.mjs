// Standalone tool-exec container entrypoint. The Docker provider runs this one
// long-lived process as the tenant container's execution world: it binds the
// published container port on all interfaces and serves `POST /exec`. The
// bundled `tool-exec.mjs` (built from `../src/tool-exec.ts`, the single source
// of truth unit-tested in tool-exec.spec.ts) provides `listenToolExecServer`.
import { listenToolExecServer } from './tool-exec.mjs'

const port = Number(process.argv[2] ?? '8642')
const host = process.argv[3] ?? '0.0.0.0'

const { server } = await listenToolExecServer(port, host)

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
