/**
 * The container worker entry: reads the run payload from `DSH_WORKFLOW_INIT`,
 * boots the unchanged `runWorkerSession` against a `MessagePort` adapter over
 * the host's duplex bridge, and closes the port (ending the poll loop) after
 * the run's terminal Result has posted so `node --input-type=module -` drains
 * and exits. Bundled self-contained by tsdown so the tool-exec container (no
 * tsx, no source tree) runs it from a single ESM file fed through stdin — the
 * bundle exceeds Linux's per-argument ceiling, which `-e` cannot carry.
 * @module @deepseek-ai/dsh-workflow-container/container-worker
 */

import { runWorkerSession } from '@deepseek-ai/dsh-workflow-worker-thread/src/session.ts'
import type { WorkerInit } from '@deepseek-ai/dsh-workflow-worker-thread/src/types.ts'
import { createHttpMessagePort } from './transport.ts'

const bridgeUrl = process.env.DSH_WORKFLOW_BRIDGE
if (bridgeUrl === undefined || bridgeUrl.length === 0) {
  throw new Error('the workflow container worker requires the DSH_WORKFLOW_BRIDGE environment variable')
}
const initRaw = process.env.DSH_WORKFLOW_INIT
if (initRaw === undefined) {
  throw new Error('the workflow container worker requires the DSH_WORKFLOW_INIT environment variable')
}
const init = JSON.parse(initRaw) as WorkerInit
const port = createHttpMessagePort(bridgeUrl)
await runWorkerSession(port, init)
port.close()
