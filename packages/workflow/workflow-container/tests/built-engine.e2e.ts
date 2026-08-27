import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const builtIndex = join(packageRoot, 'lib', 'index.js')
const builtWorker = join(packageRoot, 'lib', 'container-worker.js')
const run = promisify(execFile)

/**
 * Keyless built-artifact guard: plain Node loads `lib/index.js` and its sibling
 * `lib/container-worker.js` without tsx, then the engine drives a full `agent()`
 * round-trip through a LOCAL exec stand-in (no Docker) over the real bridge.
 * Skips until the build produces both bundles.
 */
describe.skipIf(!existsSync(builtIndex) || !existsSync(builtWorker))('built container engine (lib + lib/container-worker.js)', () => {
  it('the built engine runs a workflow with a bridged agent() call under plain node', async () => {
    const driver = join(packageRoot, `.built-engine-driver-${process.pid}.mjs`)
    try {
      await writeFile(driver, `
import { Context } from '@deepseek-ai/cordis'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import ContainerWorkflowEngine from '@deepseek-ai/dsh-workflow-container'

class LocalExecRuntime extends ContainerRuntime {
  async exec(command, args, opts) {
    return new Promise((resolve, reject) => {
      // The 290KB bundle exceeds the Windows argv ceiling; the deployment runs
      // on Linux, so the LOCAL stand-in writes '-e' scripts to a temp file
      // (exactly the transport test's launch mode) instead of passing argv.
      const spawnArgs = [...args]
      let temp = undefined
      let suppressedStdin = false
      // The 290KB bundle exceeds the Windows argv ceiling AND Linux's per-arg
      // ceiling; the deployment runs it on stdin ("--input-type=module -"). The
      // LOCAL stand-in materializes that stdin as a temp file (exactly the
      // transport test's launch mode) instead of piping it through argv/stdin.
      if (command === 'node' && spawnArgs[0] === '--input-type=module' && spawnArgs[1] === '-') {
        temp = join(tmpdir(), 'dsh-workflow-container-' + process.pid + '-' + Date.now() + '.mjs')
        writeFileSync(temp, opts?.stdin ?? '', 'utf8')
        spawnArgs.splice(0, 2, temp)
        suppressedStdin = true
      }
      const child = spawn(command, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...opts?.env } })
      const out = []
      const err = []
      child.stdout.on('data', (c) => out.push(c))
      child.stderr.on('data', (c) => err.push(c))
      child.once('error', reject)
      const onAbort = () => { child.kill('SIGKILL') }
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      child.once('close', (code) => {
        opts?.signal?.removeEventListener('abort', onAbort)
        if (temp !== undefined) rmSync(temp, { force: true })
        resolve({ exitCode: code ?? 0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      })
      if (opts?.stdin !== undefined && !suppressedStdin) child.stdin.write(opts.stdin)
      child.stdin.end()
    })
  }
}

const ctx = new Context()
await ctx.plugin(LocalExecRuntime, undefined)
await ctx.plugin(SubagentRuntime)
let agentStarts = 0
ctx.subagents.registerProvider({
  name: 'container-selected',
  capabilities: { outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
  inheritsParentContext: false,
  async start() {
    agentStarts += 1
    return {
      id: 'container-child',
      result: Promise.resolve({ output: [], structured: { answer: 42 }, stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    }
  },
})
await ctx.plugin(ContainerWorkflowEngine, { provider: 'must-not-be-used', hostBridge: '127.0.0.1' })
const run = ctx.workflowEngine.start({
  script: "const value = await agent('answer', { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } }); return value.answer",
  meta: { name: 'container-smoke', description: 'container engine smoke' },
  subagentProvider: 'container-selected',
  parent: { id: 'container-smoke-parent', options: {} },
})
const result = await run.result
await run.dispose()
if (result.stopReason !== 'completed' || result.value !== 42 || agentStarts !== 1) {
  console.error('unexpected result: ' + JSON.stringify(result) + ' starts=' + agentStarts)
  process.exit(1)
}
console.log('container-engine-smoke-ok')
`, 'utf8')
      const { stdout } = await run(process.execPath, [driver], { cwd: packageRoot, timeout: 60_000 })
      expect(stdout).toContain('container-engine-smoke-ok')
    } finally {
      await rm(driver, { force: true })
    }
  }, 120_000)
})
