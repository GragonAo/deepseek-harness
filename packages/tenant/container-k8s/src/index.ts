/**
 * Kubernetes container-runtime provider: one bare sandbox Pod per (tenant,
 * user), reached over HTTP at the Pod's own IP. Commands never go through
 * `kubectl exec`; the Pod runs the same tool-exec server the Docker provider
 * runs, so the sandbox image and the wire protocol stay one contract.
 * @module @deepseek-ai/dsh-container-k8s
 */

import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ContainerRuntime } from '@deepseek-ai/dsh-container'
import type { ContainerCommandResult, ContainerExecOptions } from '@deepseek-ai/dsh-container'
import { requireTenant, requireUser } from '@deepseek-ai/dsh-tenant'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import type { ToolExecClient } from '@deepseek-ai/dsh-container-transport'
import { buildSandboxPod, sandboxPodName } from './pod-spec.ts'
import type { SandboxMount } from './pod-spec.ts'

/**
 * Namespaces this provider refuses to operate in.
 *
 * A wrong `namespace` value would place sandbox Pods beside unrelated
 * production workloads and delete-by-name there. Refusing at load time turns a
 * configuration typo into a startup failure instead of a destructive runtime
 * action, which is the only point in the lifecycle where the value is still
 * cheap to correct.
 */
const RESERVED_NAMESPACES = [
  'default', 'kube-system', 'kube-public', 'kube-node-lease',
  'rook-ceph', 'znjj', 'znjj-middleware',
] as const

/** Configuration for the Kubernetes sandbox provider. */
export interface Config {
  /** Namespace the sandbox Pods are created in. Reserved namespaces are rejected. */
  namespace?: string
  /** Sandbox container image reference; must already be present on the node. */
  image?: string
  /** `kubectl` binary or absolute path. */
  kubectlBinary?: string
  /** Image pull policy for the sandbox container. */
  imagePullPolicy?: string
  /** Container port the tool-exec server binds inside the sandbox. */
  toolExecPort?: number
  /**
   * PersistentVolumeClaim that mirrors {@link claimRoot}. With both set, every
   * mount is projected onto this claim through `subPath`, so a sandbox carries
   * no `hostPath` at all and can start on any node. Omit to serve every tier
   * from node directories, which requires the running node to hold them.
   */
  workspaceClaim?: string
  /**
   * Path the claim is mounted at on the host, and the root each `source` is
   * resolved against to form its `subPath`. The host process mounts the same
   * claim here, so a path means the same thing on both sides and no configured
   * root changes when switching between the two modes.
   */
  claimRoot?: string
  /**
   * How long a resolved sandbox handle is reused before its state is read from
   * the cluster again, in milliseconds. Every tool call resolves a sandbox, and
   * an uncached resolution spends a `kubectl` process and an API-server round
   * trip before the command itself runs; concurrent sessions multiply that cost.
   * Keep it short enough that a replaced sandbox is noticed promptly: a stale
   * handle points at a Pod IP that no longer serves.
   */
  sandboxCacheTtlMs?: number
  /** Host root holding one sub-directory per subject, at `/global`. Omit to skip that mount. */
  usersRoot?: string
  /** Host directory holding the system-wide skill tree, mounted read-only at the same path. */
  systemRoot?: string
  /** Host directory holding the tool atlas, mounted read-only at `/tools`. */
  toolsRoot?: string
  /** Host directory holding the Python runtime, mounted read-only at the same path. */
  pythonRoot?: string
  /** Container command started in each sandbox. */
  command?: string[]
  /** Explicit environment for the sandbox container. */
  env?: Record<string, string>
  /** Wall-clock bound for one kubectl invocation. */
  cliTimeoutMs?: number
  /** Wall-clock bound for a sandbox to reach Running and Ready. */
  startTimeoutMs?: number
  /** Poll interval while waiting for readiness. */
  readyPollMs?: number
}

export const Config: z<Config> = z.object({
  namespace: z.string().description('Namespace the sandbox Pods are created in.'),
  image: z.string().description('Sandbox container image reference.'),
  kubectlBinary: z.string().default('kubectl'),
  imagePullPolicy: z.string().default('IfNotPresent'),
  toolExecPort: z.number().default(8642),
  sandboxCacheTtlMs: z.number(),
  workspaceClaim: z.string(),
  claimRoot: z.string(),
  usersRoot: z.string(),
  systemRoot: z.string(),
  toolsRoot: z.string(),
  pythonRoot: z.string(),
  command: z.array(z.string()).default(['node', 'entry.mjs']),
  env: z.dict(z.string()).default({}),
  cliTimeoutMs: z.number().default(30_000),
  startTimeoutMs: z.number().default(120_000),
  readyPollMs: z.number().default(500),
})

/** Result of one `kubectl` invocation. */
export interface K8sCommandResult {
  /** Process exit code. */
  exitCode: number
  /** Captured stdout. */
  stdout: string
  /** Captured stderr. */
  stderr: string
}

/**
 * `kubectl` invocation seam. Production spawns the binary; tests record the
 * argument vectors and answer from an in-memory cluster.
 */
export interface K8sRunner {
  /**
   * Run one `kubectl` argument vector.
   * @param args - arguments after the binary name.
   * @param stdin - manifest text written to stdin for `apply -f -`.
   * @returns the exit code and captured streams.
   */
  run(args: readonly string[], stdin?: string): Promise<K8sCommandResult>
}

/** Facts a running sandbox Pod exposes to the host. */
export interface SandboxStatus {
  /** Kubernetes phase, or `Missing` when no such Pod exists. */
  phase: string
  /** Pod IP once the sandbox is running. */
  podIP?: string
  /** Whether every container reports ready. */
  ready: boolean
  /** The spec fingerprint recorded when the Pod was created. */
  fingerprint?: string
  /** Human-readable detail for a non-running Pod (waiting reason, init failure, events). */
  detail?: string
}

/**
 * Build a {@link K8sRunner} that spawns a kubectl binary.
 * @param binary - the kubectl executable.
 * @param timeoutMs - wall-clock bound for each invocation.
 * @returns the runner.
 */
export function kubectlRunner(binary: string, timeoutMs: number): K8sRunner {
  return {
    async run(args, stdin) {
      const { spawn } = await import('node:child_process')
      return await new Promise<K8sCommandResult>((resolve, reject) => {
        const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
        const out: Buffer[] = []
        const err: Buffer[] = []
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`kubectl ${args.join(' ')} did not finish within ${timeoutMs} ms`))
        }, timeoutMs)
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
        })
        if (stdin !== undefined) child.stdin.end(stdin)
        else child.stdin.end()
      })
    },
  }
}

/** The HTTP client used to reach a running sandbox's tool-exec server. */
export type { ToolExecClient }

/**
 * Resolve the mount sources for one (tenant, user) sandbox.
 *
 * A `hostPath` source is reused verbatim as the in-sandbox path. That equality
 * is the invariant hostPath mode rests on: a divergent path makes the kubelet
 * materialize an empty directory, and an empty mount is indistinguishable from
 * a workspace that is legitimately empty.
 *
 * With {@link Config.workspaceClaim} set, the tenant's own data comes from a
 * ReadWriteMany claim instead. No node path has to exist, so the same
 * (tenant, user) can start on any node, and sub-paths inside the claim carry
 * the per-tenant and per-user split that the host directory layout carried.
 *
 * Only the source changes: every mountPath is identical in both modes, so the
 * tiers a sandbox and its readers resolve — including the skill tier at
 * `<workspaceRoot>/shared/skills` — keep their addresses.
 *
 * Deployment content stays on hostPath regardless of the claim, because the
 * global, system, tools, and Python tiers are read by every sandbox and written
 * by none; putting them on the claim would add a storage dependency without
 * moving any data that belongs to a tenant.
 *
 * The workspace root is per tenant — it is supplied by the caller rather
 * than read from provider configuration, because one provider instance serves
 * every tenant while each tenant owns a distinct workspace tree.
 * @param config - provider configuration.
 * @param workspaceRoot - the ambient tenant's own workspace root.
 * @param subject - the authenticated subject.
 * @returns the mounts, in a stable order.
 */
/**
 * Whether `candidate` is `root` itself or a descendant of it.
 * @param root - the ancestor path.
 * @param candidate - the path to test.
 * @returns true when the candidate does not escape the root.
 */
function isWithin(root: string, candidate: string): boolean {
  const rel = posix.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))
}

export function sandboxMounts(config: Config, workspaceRoot: string, subject: string): SandboxMount[] {
  const skillsPath = `${workspaceRoot}/shared/skills`
  const sources: Array<{ source: string; mountPath: string; readOnly: boolean }> = [
    { source: `${workspaceRoot}/users/${subject}`, mountPath: '/workspace', readOnly: false },
    { source: `${workspaceRoot}/shared`, mountPath: '/shared', readOnly: false },
    { source: skillsPath, mountPath: skillsPath, readOnly: true },
  ]
  if (config.usersRoot) sources.push({ source: `${config.usersRoot}/${subject}`, mountPath: '/global', readOnly: false })
  if (config.systemRoot) sources.push({ source: config.systemRoot, mountPath: config.systemRoot, readOnly: true })
  if (config.toolsRoot) sources.push({ source: config.toolsRoot, mountPath: '/tools', readOnly: true })
  if (config.pythonRoot) sources.push({ source: config.pythonRoot, mountPath: config.pythonRoot, readOnly: true })

  const claim = config.workspaceClaim
  const claimRoot = config.claimRoot
  if (!claim || !claimRoot) return sources.map(m => ({ kind: 'hostPath', ...m }))
  for (const m of sources) {
    if (!isWithin(claimRoot, m.source)) {
      throw new Error(
        `container-k8s: mount source '${m.source}' is outside claimRoot '${claimRoot}'. ` +
          'The claim mirrors that root, so every source must sit under it; widen claimRoot to a ' +
          'common ancestor of all configured roots.',
      )
    }
  }
  return sources.map(m => ({
    kind: 'claim',
    claimName: claim,
    subPath: posix.relative(claimRoot, m.source),
    mountPath: m.mountPath,
    readOnly: m.readOnly,
  }))
}

/**
 * Kubernetes container runtime (`ctx.containerRuntime`).
 *
 * One bare Pod per (tenant, user). A bare Pod has no controller, so nothing
 * recreates it behind the host's back; the host adopts an existing Pod whose
 * recorded fingerprint still matches the configuration it would use now, and
 * replaces it otherwise. Adoption is what makes a host restart cheap: without
 * it every restart would discard warm sandboxes.
 */
export class K8sContainerRuntime extends ContainerRuntime {
  private readonly config: Config
  private readonly runner: K8sRunner
  private readonly client: ToolExecClient
  /** Resolved sandbox handles, keyed by (tenant, subject), valid until `expiresAt`. */
  private readonly sandboxes = new Map<string, { status: SandboxStatus; expiresAt: number }>()
  /** Starts already in flight, so concurrent callers share one instead of racing. */
  private readonly starting = new Map<string, Promise<SandboxStatus>>()

  constructor(ctx: Context, config: Config, runner?: K8sRunner, client?: ToolExecClient) {
    super(ctx)
    const namespace = config.namespace
    if (!namespace) throw new Error('container-k8s: Config.namespace is required')
    if ((RESERVED_NAMESPACES as readonly string[]).includes(namespace)) {
      throw new Error(`container-k8s: namespace '${namespace}' is reserved; sandbox Pods must not be created beside unrelated workloads`)
    }
    if (!config.image) throw new Error('container-k8s: Config.image is required')
    this.config = config
    this.runner = runner ?? kubectlRunner(config.kubectlBinary ?? 'kubectl', config.cliTimeoutMs ?? 30_000)
    this.client = client ?? fetchToolExecClient
  }

  /**
   * Run one command in the ambient tenant's sandbox and capture its streams.
   * @param command - the executable inside the sandbox.
   * @param args - positional arguments (never shell-interpreted here).
   * @param opts - optional stdin feed, cwd, env, and cancellation.
   * @returns the command's exit code and captured stdout/stderr.
   * @throws `TenantError` code `NO_TENANT_IN_SCOPE` outside an authenticated request.
   */
  async exec(command: string, args: readonly string[], opts?: ContainerExecOptions): Promise<ContainerCommandResult> {
    const tenant = requireTenant()
    const subject = requireUser()
    const status = await this.ensureSandbox(tenant, String(subject), opts?.signal)
    if (!status.podIP) throw new Error(`container-k8s: sandbox ${status.phase} without a Pod IP${status.detail ? `: ${status.detail}` : ''}`)
    const baseUrl = `http://${status.podIP}:${this.config.toolExecPort}`
    const result = await this.client.exec(baseUrl, {
      argv: [command, ...args],
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.env !== undefined ? { env: { ...opts.env } } : {}),
      ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
    }, opts?.signal)
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  /**
   * Return a running sandbox for one (tenant, user), creating or replacing it
   * as needed.
   * @param tenant - the ambient tenant record; its `workspaceRoot` owns the sandbox's mounts.
   * @param subject - the authenticated subject.
   * @param signal - the caller's cancellation, honoured while waiting for readiness.
   * @returns the sandbox's observed status.
   */
  private async ensureSandbox(tenant: Tenant, subject: string, signal?: AbortSignal): Promise<SandboxStatus> {
    const key = `${tenant.id}\u0000${subject}`
    const cached = this.sandboxes.get(key)
    if (cached && cached.expiresAt > Date.now() && cached.status.ready) return cached.status
    const inFlight = this.starting.get(key)
    if (inFlight) return await inFlight
    const started = this.startSandbox(tenant, subject, signal)
    this.starting.set(key, started)
    try {
      const status = await started
      this.sandboxes.set(key, { status, expiresAt: Date.now() + (this.config.sandboxCacheTtlMs ?? 5000) })
      return status
    } finally {
      this.starting.delete(key)
    }
  }

  /**
   * Resolve one sandbox from the cluster, creating or replacing it as needed.
   * @param tenant - the ambient tenant record.
   * @param subject - the authenticated subject.
   * @param signal - the caller's cancellation.
   * @returns the sandbox's observed status.
   */
  private async startSandbox(tenant: Tenant, subject: string, signal?: AbortSignal): Promise<SandboxStatus> {
    const tenantId = String(tenant.id)
    const podName = sandboxPodName(tenantId, subject)
    const mounts = sandboxMounts(this.config, tenant.workspaceRoot, subject)
    const { spec, fingerprint } = buildSandboxPod({
      namespace: this.config.namespace as string,
      image: this.config.image as string,
      imagePullPolicy: this.config.imagePullPolicy ?? 'IfNotPresent',
      podName,
      command: this.config.command ?? ['node', 'entry.mjs'],
      mounts,
      env: this.config.env ?? {},
      toolExecPort: this.config.toolExecPort ?? 8642,

    })
    spec.metadata.annotations['dsh.dev/spec-fingerprint'] = fingerprint
    spec.metadata.annotations['dsh.dev/tenant'] = tenantId
    spec.metadata.annotations['dsh.dev/subject'] = subject

    const existing = await this.readStatus(podName)
    if (existing.phase !== 'Missing') {
      // A sandbox is shared by every host instance serving this (tenant, user),
      // not owned by the instance that happened to start it. Two instances that
      // disagree about the spec would each keep replacing the other's sandbox,
      // so that disagreement is a deployment fault: report it and leave the
      // running sandbox alone.
      if (existing.fingerprint !== fingerprint) {
        throw new Error(
          `container-k8s: sandbox ${podName} runs a different spec than this host would create ` +
            `(recorded ${existing.fingerprint || '<none>'}, local ${fingerprint}). Instances serving one ` +
            'tenant must agree on image, command, mounts and environment; align them, or the ' +
            'recorded sandbox must be deleted before this host can serve the tenant.',
        )
      }
      // Running and Pending are both live: adopt them. Adopting a sandbox that
      // another instance is still starting is what keeps one instance from
      // deleting another's work, and the readiness wait below fails loudly if
      // that sandbox never becomes usable.
      if (existing.phase === 'Running' || existing.phase === 'Pending') {
        return await this.waitReady(podName, signal)
      }
      // A sandbox that has exited cannot be reused; replace it without waiting,
      // so one instance's startup is not held hostage to another's teardown.
      await this.runner.run(['-n', this.config.namespace as string, 'delete', 'pod', podName, '--ignore-not-found', '--wait=false'])
    }

    const created = await this.runner.run(['-n', this.config.namespace as string, 'create', '-f', '-'], JSON.stringify(spec))
    // Two instances can pass the check above at the same moment and both try to
    // create. Kubernetes picks one winner; the loser adopts what the winner
    // created rather than reporting a failure the caller can do nothing about.
    if (created.exitCode !== 0 && !/AlreadyExists/i.test(created.stderr)) {
      throw new Error(`container-k8s: could not create sandbox ${podName}: ${created.stderr.trim() || created.stdout.trim()}`)
    }
    return await this.waitReady(podName, signal)
  }

  /**
   * Read one Pod's phase, readiness, IP, and recorded fingerprint.
   * @param podName - the sandbox Pod name.
   * @returns the observed status; `Missing` when the Pod does not exist.
   */
  private async readStatus(podName: string): Promise<SandboxStatus> {
    const result = await this.runner.run(['-n', this.config.namespace as string, 'get', 'pod', podName, '-o', 'json'])
    if (result.exitCode !== 0) {
      if (/NotFound/i.test(result.stderr)) return { phase: 'Missing', ready: false }
      throw new Error(`container-k8s: could not read sandbox ${podName}: ${result.stderr.trim()}`)
    }
    return parsePodStatus(result.stdout)
  }

  /**
   * Read the recent events Kubernetes recorded for one sandbox.
   *
   * A sandbox whose `hostPath` sources are missing never starts its init
   * container: the kubelet refuses the volume first and reports only through
   * events, leaving the Pod in `Pending`. Without those events the failure
   * reads as "still starting" until the start deadline, which tells an operator
   * nothing about which path to create.
   * @param podName - the sandbox Pod name.
   * @returns one line per event, most recent last.
   */
  private async readEvents(podName: string): Promise<string[]> {
    const result = await this.runner.run([
      '-n', this.config.namespace as string, 'get', 'events',
      '--field-selector', `involvedObject.name=${podName}`,
      '-o', 'json',
    ])
    if (result.exitCode !== 0) return []
    try {
      const parsed = JSON.parse(result.stdout) as { items?: { reason?: string; message?: string; type?: string }[] }
      return (parsed.items ?? [])
        .filter(e => e.message)
        .map(e => `${e.type ?? 'Event'} ${e.reason ?? ''}: ${e.message}`.trim())
    } catch {
      // A malformed event list must not replace the real failure with a parse
      // error; the caller already has the Pod status to report.
      return []
    }
  }

  /**
   * Poll until the sandbox reports ready, describing why it has not otherwise.
   * @param podName - the sandbox Pod name.
   * @param signal - the caller's cancellation.
   * @returns the ready status.
   */
  private async waitReady(podName: string, signal?: AbortSignal): Promise<SandboxStatus> {
    const startTimeoutMs = this.config.startTimeoutMs ?? 120_000
    const pollMs = this.config.readyPollMs ?? 500
    const deadline = Date.now() + startTimeoutMs
    let last: SandboxStatus = { phase: 'Unknown', ready: false }
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('container-k8s: sandbox start cancelled by the caller')
      last = await this.readStatus(podName)
      if (last.phase === 'Running' && last.ready && last.podIP) return last
      if (terminalPhases.has(last.phase)) break
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    const events = await this.readEvents(podName)
    throw new Error(`container-k8s: sandbox ${podName} did not become ready within ${startTimeoutMs} ms (${describeStatus(last)})${events.length > 0 ? `; events: ${events.join(' | ')}` : ''}`)
  }
}

/** Phases a sandbox never leaves without being recreated. */
const terminalPhases = new Set(['Failed', 'Succeeded', 'Missing'])

/**
 * Render a status into an actionable message.
 * @param status - the last observed status.
 * @returns a single-line explanation.
 */
function describeStatus(status: SandboxStatus): string {
  const parts = [`phase=${status.phase}`, `ready=${status.ready}`]
  if (status.detail) parts.push(status.detail)
  return parts.join(' ')
}

/**
 * Derive a status from `kubectl get pod -o json` output.
 * @param json - the Pod document.
 * @returns phase, readiness, IP, fingerprint, and any waiting/terminated reason.
 */
export function parsePodStatus(json: string): SandboxStatus {
  const pod = JSON.parse(json) as {
    status?: {
      phase?: string
      podIP?: string
      conditions?: { type: string; status: string }[]
      initContainerStatuses?: { state?: Record<string, { reason?: string; message?: string }> }[]
      containerStatuses?: { state?: Record<string, { reason?: string; message?: string }> }[]
    }
    metadata?: { annotations?: Record<string, string> }
  }
  const phase = pod.status?.phase ?? 'Unknown'
  const ready = (pod.status?.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True')
  const detail: string[] = []
  for (const group of [pod.status?.initContainerStatuses, pod.status?.containerStatuses]) {
    for (const container of group ?? []) {
      const state = container.state ?? {}
      for (const [kind, value] of Object.entries(state)) {
        if (kind === 'running' || kind === 'terminated' && !value.reason) continue
        if (value.reason || value.message) detail.push(`${kind}: ${value.reason ?? ''}${value.message ? ` (${value.message})` : ''}`.trim())
      }
    }
  }
  return {
    phase,
    ready,
    ...(pod.status?.podIP ? { podIP: pod.status.podIP } : {}),
    ...(pod.metadata?.annotations?.['dsh.dev/spec-fingerprint'] ? { fingerprint: pod.metadata.annotations['dsh.dev/spec-fingerprint'] } : {}),
    ...(detail.length > 0 ? { detail: detail.join('; ') } : {}),
  }
}

/** Default {@link ToolExecClient}: a plain `fetch` to the sandbox address. */
const fetchToolExecClient: ToolExecClient = {
  async exec(baseUrl, req, signal) {
    const response = await fetch(`${baseUrl}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw new Error(`container-k8s: tool-exec returned HTTP ${response.status}`)
    return await response.json() as { exitCode: number; stdout: string; stderr: string }
  },
}

export default K8sContainerRuntime
