/**
 * Self-contained in-container program runner: the fixed CommonJS script the
 * runtime runs as `node -e` inside the tenant's container. It reads the boot
 * payload (program source, binding namespace declarations, output cap) from
 * stdin, bridges every binding call over the host's loopback HTTP surface named
 * by `DSH_CODE_BRIDGE`, runs the program as a strict async-function body, and
 * prints exactly one JSON result frame to stdout.
 * @module @deepseek-ai/dsh-code-runtime-container/src/bootstrap
 */

import type { CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'

/** Binding namespace declarations the host sends in the boot payload. */
export interface ContainerBootNamespace {
  /** The global identifier the program sees (validated by the host). */
  global: string
  /** The callable member names under that global. */
  names: string[]
}

/** Everything the in-container program needs, other than the bridge URL (env). */
export interface ContainerBootData {
  /** The type-stripped program body. */
  code: string
  /** The binding namespace declarations, in declaration order. */
  namespaces: ContainerBootNamespace[]
  /** Hard cap for the serialized logs-plus-result payload, in bytes. */
  maxOutputBytes: number
}

/** One completed run's frame, printed as a single stdout line. */
export interface ContainerResultFrame {
  /** The program's lossless-JSON completion value, when it returned one. */
  value?: CodeJsonValue
  /** The ordered captured logs (console + stdout/stderr writes). */
  logs: string[]
  /** Present iff the run failed; kinds mirror the seam's taxonomy. */
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string }
}

/**
 * The fixed in-container bootstrap. Written as a plain CommonJS string (it runs
 * under `node -e`, which defaults to CommonJS) with no backticks or template
 * interpolation of its own, so it slabs into this package verbatim. The host
 * injects the boot payload through stdin and the bridge URL through
 * `DSH_CODE_BRIDGE`; every other run input arrives with the program itself.
 */
export const CONTAINER_BOOTSTRAP: string = `import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
let boot
try { boot = JSON.parse(readFileSync(0, 'utf8')) } catch { boot = null }
if (boot === null || typeof boot.code !== 'string' || !Array.isArray(boot.namespaces)) {
  process.stderr.write('dsh-code-runtime-container: malformed boot payload\\n')
  process.exit(2)
}
const bridge = process.env.DSH_CODE_BRIDGE || ''
const maxOutputBytes = (typeof boot.maxOutputBytes === 'number' && boot.maxOutputBytes > 0) ? boot.maxOutputBytes : 67108864

function assertJson(v, path) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number at ' + path); return }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(v, i)) throw new Error('sparse array at ' + path)
      assertJson(v[i], path + '[' + i + ']')
    }
    return
  }
  if (typeof v === 'object') { for (const k of Object.keys(v)) assertJson(v[k], path + '.' + k); return }
  throw new Error('non-JSON ' + typeof v + ' at ' + path)
}
function snapshot(value) {
  try { assertJson(value, 'root'); return JSON.parse(JSON.stringify(value)) } catch { return undefined }
}

let logBytes = 2
const logs = []
let truncated = false
function pushLog(text) {
  if (truncated) return
  const as = String(text)
  const more = logBytes + (logs.length > 0 ? 1 : 0) + JSON.stringify(as).length
  if (more > maxOutputBytes) { truncated = true; return }
  logBytes = more
  logs.push(as)
}
const levels = ['log', 'info', 'warn', 'error', 'debug']
const consoleShim = Object.create(null)
for (const level of levels) {
  consoleShim[level] = function () {
    const parts = []
    for (let i = 0; i < arguments.length; i++) {
      const arg = arguments[i]
      parts.push(typeof arg === 'string' ? arg : inspect(arg, { depth: 4, maxArrayLength: 100, maxStringLength: 10000 }))
    }
    pushLog(parts.join(' '))
  }
}
const stdoutWrite = process.stdout.write.bind(process.stdout)
const stderrWrite = process.stderr.write.bind(process.stderr)
process.stdout.write = function (chunk) { pushLog(typeof chunk === 'string' ? chunk : String(chunk)); return true }
process.stderr.write = function (chunk) { pushLog(typeof chunk === 'string' ? chunk : String(chunk)); return true }

function makeErrorClass(descriptor) {
  return class extends Error {
    constructor(member, message) {
      super(message)
      Object.defineProperty(this, 'name', { enumerable: true, value: descriptor.name })
      Object.defineProperty(this, descriptor.memberNameProperty, { enumerable: true, value: member })
    }
  }
}
const errorClasses = new Map()
for (const ns of boot.namespaces) {
  if (ns.errorClass) errorClasses.set(ns.global, makeErrorClass(ns.errorClass))
}

async function callBinding(global, name, args) {
  const detached = snapshot(args)
  if (detached === undefined) throw new Error('binding arguments must be lossless JSON (' + global + '.' + name + ')')
  let response
  try {
    response = await fetch(bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ global: global, name: name, args: detached }),
    })
  } catch (error) {
    throw new Error('binding bridge unreachable: ' + (error && error.message ? error.message : String(error)))
  }
  let reply
  try { reply = await response.json() } catch {
    throw new Error('binding bridge returned non-JSON (status ' + response.status + ')')
  }
  if (reply === null || reply.ok !== true) {
    throw new Error(reply !== null && reply.message ? reply.message : 'binding call failed')
  }
  return reply.value
}

const namespaceObjs = boot.namespaces.map((ns) => {
  const errorClass = errorClasses.get(ns.global)
  const obj = Object.create(null)
  for (const name of ns.names) {
    Object.defineProperty(obj, name, {
      enumerable: true,
      value: async (args) => {
        try {
          return await callBinding(ns.global, name, args)
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          if (errorClass) { const crafted = new errorClass(name, message); throw crafted }
          throw new Error(message)
        }
      },
    })
  }
  return obj
})

const AsyncFunction = (async () => {}).constructor
const paramGlobals = []
const paramErrorNames = []
const argNamespaces = []
const argErrorClasses = []
for (const ns of boot.namespaces) {
  paramGlobals.push(ns.global)
  argNamespaces.push(namespaceObjs[argNamespaces.length])
  if (ns.errorClass) {
    paramErrorNames.push(ns.errorClass.name)
    argErrorClasses.push(errorClasses.get(ns.global))
  }
}
let value
let failure
try {
  const fn = new AsyncFunction(...paramGlobals, ...paramErrorNames, 'console', "'use strict';\\n" + boot.code)
  value = await fn(...argNamespaces, ...argErrorClasses, consoleShim)
} catch (error) {
  failure = { kind: 'exception', message: error && error.stack ? error.stack : String(error) }
}

let frame
if (failure !== undefined) {
  const messageBytes = JSON.stringify(failure.message).length
  frame = messageBytes + logBytes > maxOutputBytes
    ? { logs: logs, error: { kind: 'output-limit', message: 'outer output exceeded ' + maxOutputBytes + ' bytes' } }
    : { logs: logs, error: failure }
} else if (truncated) {
  frame = { logs: logs, error: { kind: 'output-limit', message: 'outer output exceeded ' + maxOutputBytes + ' bytes' } }
} else if (value === undefined) {
  frame = { logs: logs }
} else {
  const detached = snapshot(value)
  if (detached === undefined) {
    frame = { logs: logs, error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } }
  } else if (JSON.stringify(detached).length + logBytes > maxOutputBytes) {
    frame = { logs: logs, error: { kind: 'output-limit', message: 'outer output exceeded ' + maxOutputBytes + ' bytes' } }
  } else {
    const framed = { logs: logs, value: detached }
    frame = framed
  }
}
stdoutWrite(JSON.stringify(frame) + '\\n')
process.exit(0)
`
