/**
 * Pure assembly of one sandbox Pod's specification. Every value here is
 * derived from configuration and the ambient (tenant, user) scope, so the
 * result is a deterministic function of its inputs — the property the
 * spec-fingerprint and its tests depend on.
 * @module @deepseek-ai/dsh-container-k8s/pod-spec
 */

import { createHash } from 'node:crypto'

/**
 * One mount source and the absolute path it must appear at inside the sandbox.
 *
 * The two arms differ in where the bytes live, not in where the sandbox sees
 * them: a caller can switch a tier between a node directory and a shared claim
 * without changing any path the sandbox or its readers resolve.
 */
export type SandboxMount =
  | {
    /** A directory on the node that runs the sandbox. */
    kind: 'hostPath'
    /**
       * Absolute path on the node. It MUST equal {@link mountPath}
       * character-for-character: Kubernetes silently materializes an empty
       * directory when the two differ, and a silently empty mount is
       * indistinguishable from a legitimately empty workspace.
       */
    source: string
    mountPath: string
    readOnly: boolean
  }
  | {
    /** A subdirectory of a PersistentVolumeClaim paired with the sandbox. */
    kind: 'claim'
    /** Name of the claim in the sandbox's own namespace. */
    claimName: string
    /** Path from the claim's root; the per-tenant and per-user split lives here. */
    subPath: string
    mountPath: string
    readOnly: boolean
  }

/** Inputs that determine one sandbox Pod's full specification. */
export interface SandboxPodInput {
  /** Kubernetes namespace the Pod is created in. */
  namespace: string
  /** Sandbox container image reference. */
  image: string
  /** Image pull policy; `Never` is how an air-gapped node uses a pre-imported image. */
  imagePullPolicy: string
  /** RFC1123 Pod name, normally from {@link sandboxPodName}. */
  podName: string
  /** Container command executed by the tool-exec server entrypoint. */
  command: readonly string[]
  /** Bind sources and their in-sandbox paths. */
  mounts: readonly SandboxMount[]
  /** Explicit environment for the sandbox container. */
  env: Readonly<Record<string, string>>
  /** Container port the host reaches the tool-exec server on. */
  toolExecPort: number
  /** Optional resource requests and limits. */
  resources?: Record<string, unknown>
}

/** A Pod specification, structurally complete but typed loosely at the object level. */
export interface SandboxPodSpec {
  apiVersion: 'v1'
  kind: 'Pod'
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> }
  spec: Record<string, unknown>
}

/**
 * Derive an RFC1123 DNS-label-safe name for one (tenant, user) sandbox.
 *
 * Kubernetes object names admit only lowercase alphanumerics, `-` and `.`,
 * while a DSH subject may contain underscores, uppercase, or characters from
 * any script. The original pair is preserved verbatim in annotations, so the
 * name is a lossy handle and never a source of identity.
 * @param tenantId - tenant identifier, already restricted by DSH.
 * @param subject - authenticated subject within the tenant.
 * @returns a name no longer than 63 characters, valid as a Pod name.
 */
export function sandboxPodName(tenantId: string, subject: string): string {
  const digest = createHash('sha256').update(`${tenantId}\u0000${subject}`).digest('hex').slice(0, 12)
  const fold = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const head = fold(`dsh-${tenantId}-${subject}`).slice(0, 50).replace(/-+$/, '')
  return `${head || 'dsh'}-${digest}`
}

/**
 * Assemble the sandbox Pod specification for one (tenant, user) scope.
 *
 * The Pod is a bare Pod rather than a Deployment, Job, or StatefulSet: it has
 * no controller to restart it, which is what the runtime wants — the host owns
 * the sandbox lifecycle and adopts an existing Pod instead of replacing it.
 *
 * The init container re-checks every required mount *after* the kubelet has
 * mounted them. Host-side existence checks establish only that the host can
 * read a path, which is a necessary but not sufficient condition for the
 * sandbox being able to mount it; the init container observes the mount result
 * itself, and its failure keeps the Pod out of `Running` indefinitely.
 * @param input - the resolved specification inputs.
 * @returns the Pod specification and its fingerprint.
 */
export function buildSandboxPod(input: SandboxPodInput): { spec: SandboxPodSpec; fingerprint: string } {
  const annotations: Record<string, string> = {
    'dsh.dev/tool-exec-port': String(input.toolExecPort),
  }
  // The check runs inside the sandbox, so it must name the path the sandbox
  // sees — the mount path, never the host source. A source path is absent from
  // the container's filesystem whenever the two differ, which would fail every
  // such mount on a perfectly healthy host.
  const initCheck = input.mounts
    .map(m => `[ -e "${m.mountPath}" ] || { echo "MISSING ${m.mountPath}"; exit 1; }`)
    .join('; ')
  const spec: SandboxPodSpec = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: input.podName,
      namespace: input.namespace,
      labels: { 'app.kubernetes.io/name': 'dsh-tool-exec', 'dsh.dev/managed': 'true' },
      annotations,
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      initContainers: [
        {
          name: 'verify-mounts',
          image: input.image,
          imagePullPolicy: input.imagePullPolicy,
          command: ['/bin/sh', '-c', initCheck],
          volumeMounts: input.mounts.map(m => ({ name: mountName(m.mountPath), mountPath: m.mountPath, readOnly: true })),
        },
      ],
      containers: [
        {
          name: 'tool-exec',
          image: input.image,
          imagePullPolicy: input.imagePullPolicy,
          command: [...input.command],
          // Sorted so the fingerprint depends on the environment's content,
          // not on the insertion order of the object that supplied it: an
          // order-sensitive digest would make two hosts that read the same
          // configuration disagree about whether a running sandbox is current.
          env: Object.entries(input.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, value]) => ({ name, value })),
          ports: [{ name: 'tool-exec', containerPort: input.toolExecPort }],
          // readOnlyRootFilesystem leaves nothing writable; a command that
          // needs a temporary file would otherwise fail for a reason unrelated
          // to what it was asked to do.
          volumeMounts: [
            ...input.mounts.map(m => ({ name: mountName(m.mountPath), mountPath: m.mountPath, readOnly: m.readOnly })),
            { name: 'tmp', mountPath: '/tmp', readOnly: false },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
            readOnlyRootFilesystem: true,
          },
          ...(input.resources ? { resources: input.resources } : {}),
        },
      ],
      volumes: [
        ...input.mounts.map(m =>
          m.kind === 'hostPath'
            ? { name: mountName(m.mountPath), hostPath: { path: m.source, type: 'Directory' } }
            : {
              name: mountName(m.mountPath),
              persistentVolumeClaim: { claimName: m.claimName },
              subPath: m.subPath,
            },
        ),
        { name: 'tmp', emptyDir: {} },
      ],
      tolerations: [{ operator: 'Exists' }],
    },
  }
  return { spec, fingerprint: fingerprintOf(spec) }
}

/**
 * Stable volume name for a mount path.
 *
 * Volume names share the RFC1123 label rules with Pod names, so a path is
 * folded the same way and disambiguated by a digest of the *original* path —
 * folding alone would collide two distinct paths onto one name.
 * @param mountPath - the absolute in-sandbox path.
 * @returns a DNS-label-safe volume name.
 */
export function mountName(mountPath: string): string {
  const digest = createHash('sha256').update(mountPath).digest('hex').slice(0, 8)
  return `m-${mountPath.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase()}-${digest}`
}

/**
 * Content fingerprint of a resolved Pod specification.
 *
 * Recorded as an annotation so a later host process can tell "this Pod is the
 * one I would have created" from "this Pod is stale", which is the whole basis
 * of adopting a sandbox across a host restart instead of rebuilding it.
 * @param spec - the assembled specification.
 * @returns a hex digest over a canonically ordered rendering of the spec.
 */
export function fingerprintOf(spec: SandboxPodSpec): string {
  return createHash('sha256').update(canonicalize(spec)).digest('hex')
}

/**
 * Render a value with object keys in sorted order.
 *
 * JSON.stringify preserves insertion order, so two structurally equal specs
 * built by different code paths would otherwise fingerprint differently.
 * @param value - any JSON-representable value.
 * @returns a stable string rendering.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}
