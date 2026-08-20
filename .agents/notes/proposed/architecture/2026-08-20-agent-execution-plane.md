# Agent Note: Agent plane and execution plane — container-bound tool execution for multi-tenant containment

Status: proposed

English | [中文](2026-08-20-agent-execution-plane.zh.md)

## Problem

A tool call issued by the model executes in the harness process today: the agent loop drives `ctx.tools.execute()`, and the registered `ToolDefinition.execute` body runs where the Cordis context lives — beside the session log, the goal state, the approval channel, and every credential the harness holds. The filesystem, subprocess, shell, terminal, and LSP seams make files and processes portable, but the tool's execution body, its argument construction, result parsing, and post-processing stay in-process. The E2B realization moves the mutable coding world into a remote sandbox and leaves the tool bodies on the host.

Three existing decisions name the extension without realizing it:

- The sandbox seam confines same-world subprocess **file effects** only, and states that containers, microVMs, and remote executors are not its backends — they "replace the Service Providers for whole capability seams (`ctx.shell`, `ctx.fs`) as environment-coherent groups"; "More environments — an environment-coherent capability group example" is a deferred phase.
- Code Mode's runtime seam carries an `isolation` descriptor whose designed values include `'container'`, and records that "deployments that need a hard multi-tenant boundary need a container-class backend for both code and bash".
- The portable-execution-world decision establishes that `ctx.fs` and `ctx.subprocess` are one execution world consumed by Bash, PTY, and LSP, and that the host keeps the agent loop, agent/session state, session logs, LLM calls, prompts, tools, authority, skills, and subagent orchestration.

For a multi-tenant host this leaves one boundary unbuilt. The agent plane — session, memory, log, model calls, orchestration — must host many tenants at once, so no tenant-directed tool work may execute there. Registered tools are a trusted same-process contract today; retiring that assumption is the point.

## Proposal

Two decisions:

1. **An execution plane.** The filesystem, subprocess (including `spawnTerminal`), shell, terminal, LSP, code-runtime, and workflow providers mount as **one environment-coherent group inside a per-tenant container** — the sandbox note's "More environments" phase, realized as the execution plane. The agent plane retains the session log and persistence, goal state, the agent loop, model transport, the tool-visibility registry, the tool scheduling pipeline (`tools/pre-execute` → guards → `tools/post-execute` → `tools/result`), policy, approval, credentials, and prompt assembly.

2. **A split tool definition.** A tool's control-plane projection — `name`, `description`, `parameters`, `output.schema`, `render`, `presentCall`, `presentResult`, pure data and pure functions — stays on the agent plane. Its `execute` body moves to the execution plane. The registry resolves the control-plane projection locally, forwards `name` + lossless-JSON arguments to the execution-plane process over a cross-plane call, and receives a lossless-JSON value plus logs back.

### Plane boundaries

| Concern | Agent plane (host process) | Execution plane (per-tenant container) |
|---|---|---|
| Session log, persistence, projection, titles, telemetry | owns | never sees |
| Goal state, memory | owns | never sees |
| Agent loop, orchestration, scheduling pipeline (`tools/*` events) | owns | never sees |
| Model transport, prompt assembly, tool-visibility flip | owns | never sees |
| Policy, approval, credentials, sandbox policy | owns; injects credentials into the container, never through model-visible parameters | receives injected env only |
| Tool control-plane projection (`schema`, `render`, presenters) | owns | provider-agnostic |
| `execute` body | never runs it | owns |
| `ctx.fs` / `ctx.subprocess` / `ctx.shell` / `ctx.terminals` / `ctx.lsp` providers | consumes as the routed seam | owns |
| `run_code` / `workflow` runtime | routes calls | owns (`isolation: 'container'`) |
| User-mounted tools, tool scripts, environment, working directory | declares the mount | owns |

**Not every tool moves.** `todo`, `goal`, `session-query`, `ask-user`, `jobs`, `subagent-control`, and `tool-cordis` operate on agent-plane state — the session log, goal domain, approval channel, job registry, and plugin tree. They stay on the agent plane because moving them would move the memory the agent plane owns. Only **execution-world tools** — `bash`, `pwsh`, `terminal`, the filesystem tools, `glob`/`grep`, `lsp`, `web` effect-bearing operations, `run_code`, `workflow`, and user-mounted tools — move to the execution plane. This matches the line the sandbox note already draws between subprocess-confined and in-process tools.

### Split tool definition

`defineTool` owns `execute`, `render`, and the presenters as one object. The split separates the two halves without inventing two registries:

- **Control-plane projection** — everything pure: `name`, `description`, `parameters`, `output.schema` (the enforced raw subset), `render`, `presentCall`, `presentResult`, `finalizeContent`. Compiled by `dsh-tools` on the agent plane for prompt assembly, arg validation, output validation, and UI replay.
- **Execution body** — `execute`. Described on the agent plane; resident and run on the execution plane.

Two mounting forms coexist:

- **First-party execution bodies** (bash, fs, lsp, terminal…): those packages already route every external effect through `ctx.fs`/`ctx.subprocess`; executing them inside the container leaves their logic unchanged and moves only their process home.
- **User-mounted tools**: a tool is a script plus a schema declaration, submitted per tenant, resolved against the tool-schema subset, and run by the execution-plane runtime through a fixed ABI — JSON arguments in, lossless-JSON value and logs out. The agent plane never executes the script.

### Cross-plane tool call

One call = the agent plane resolving the control-plane projection, running its scheduling pipeline, and forwarding a bounded request — `name`, lossless-JSON arguments, call identity, an abort signal — to the execution-plane process, which runs the body and returns a lossless-JSON value and ordered logs. The mechanism reuses two shipped precedents:

- Code Mode's dispatch bridge already routes an isolated substrate's tool wants back through the registry with lossless-JSON arguments, deterministic call ids, and `tool/code-dispatch` logging. The execution plane inverts that direction: the agent plane routes the call out, the execution plane runs the body.
- `subagent-acp` already runs a per-child process with ACP RPC, credential scrubbing, dispose/grace, and lifecycle teardown. The execution-plane process reuses that process-and-lifecycle scaffolding.

Logging obeys the model-visible ⟺ logged invariant: execution-plane effects return the events the agent plane appends, so `tool/call` + `tool/result` (and any execution-internal events) still reconstruct the request from the session log alone.

### Milestones

- **M1 — execution world down.** Point `ctx.fs` / `ctx.subprocess` / `ctx.shell` / `ctx.terminals` / `ctx.lsp` at one container-bound provider group; verify bash, fs search, LSP, and terminal run entirely inside the container while tool bodies remain host-side. This is the "More environments" phase.
- **M2 — code and workflow runtimes down.** Ship `ctx.codeRuntime` with `isolation: 'container'` and a container workflow provider, replacing the worker-thread backends.
- **M3 — tool execution down.** Add the split tool definition and the cross-plane call; mount first-party `execute` bodies and user tools inside the execution plane. After M3 no tenant-directed tool work runs on the agent plane. Landed: the `ToolExecutor` seam (`@deepseek-ai/dsh-tool-executor`), the in-process verification provider (`@deepseek-ai/dsh-tool-executor-in-process`), and the `dispatchToolBody` cut point routing through `ctx.toolExecutor` with a direct-dispatch fallback; the container provider and execution-plane image remain.
- **M4 — multi-tenant.** Tenant identity and routing, per-tenant containers, credential injection, network policy, working-directory mounts, log flow-back into per-tenant sessions, and container lifecycle/reclamation.

### Open questions

Each is gated on evidence this proposal does not yet have:

- **Container substrate** — Docker, Firecracker/microVM, gVisor, or an OCI runtime; multi-tenant isolation strength may require a microVM or gVisor rather than shared-kernel containers.
- **Network policy** — `SandboxMode` claims file effects only, so a network dimension is a separate vocabulary, added at its enforcing provider.
- **Tenant lifecycle and routing** — per-tenant standing container versus on-demand spawn with idle reclamation; which call fields carry tenant identity.
- **Credential injection** — how agent-plane credentials reach container env without crossing a model-visible parameter or log.
- **Streaming and persistent tools** — terminal sessions and streaming bash output cross the plane as handles, reusing the subprocess handle contract; the exact framing is M1/M2 work.

## Alternatives considered

**A generic `ToolRuntime` wrapper that confines every tool in place.** Rejected, and already rejected by the sandbox note: in-process tools close over `ctx`, so an `execve`-shaped wrapper is mechanically false. The execution plane moves the body out of the process instead of wrapping it; the two are distinct.

**Move the whole harness into the container.** Rejected, and already rejected by the portable-execution-world note: it entangles provider work with plugin loading, credentials, model transport, session durability, and supervision. The execution plane splits at the capability seams, not at the process boundary of the harness.

**Rely on the worker-thread backends as the isolation boundary.** Rejected, and already recorded as a deliberate non-goal by the code-mode note: the worker provides containment, not a security boundary, and a hard multi-tenant boundary needs `isolation: 'container'`.

**Keep tool execution in-process and sandbox only the OS effects.** This is the status quo and exactly what multi-tenancy cannot accept: the model-directed `execute` body keeps running on the agent plane beside session memory and credentials. Rejected as the target; M1 alone is this shape and is an intermediate, not a landing point.

**Run user tools through the bash executor.** Rejected: shell-string quoting degrades structured arguments, discards the tool-schema validation the registry already enforces, and re-enters the host-plane bash consumer the split exists to avoid. A script ABI with JSON framing keeps user tools behind the same schema subset as first-party tools.

**A separate container per capability rather than one environment-coherent group.** Rejected, and already rejected by the portable-execution-world note: file and process operations must share identity and state, so a per-tool split recreates the two-worlds failure the execution world exists to prevent.

## Acceptance criteria

- Every execution-world tool call dispatches to the execution plane; the agent plane runs no `execute` body for those tools.
- A model-visible request reconstructs from the session log alone, including cross-plane `tool/call`/`tool/result` and execution-internal events; the model-visible ⟺ logged invariant holds across the plane boundary.
- First-party bash, fs, glob/grep, LSP, and terminal behave unchanged through the routed seam, provider-neutral, with no consumer forks — the same guarantee the execution-world seams already give local versus E2B providers.
- `run_code` and `workflow` run under `isolation: 'container'`, reachable through the existing seam without touching `dsh-tools` presentation beyond the runtime descriptor.
- A user-mounted tool validates against the enforced raw JSON Schema subset, runs only on the execution plane, and cannot observe agent-plane session, goal, approval, or credential state.
- Credentials reach the container environment without appearing in any model-visible parameter, tool result, or log entry.
- Disposal, cancellation, and container reclamation reach quiescence per defensive patterns, matching the lifecycle scaffolding `subagent-acp` and the workflow host already provide.

## Risks

**Trust-model change.** `ctx.tools` moves from a trusted same-process contract to a cross-plane boundary. This is deliberate — multi-tenancy requires treating tool execution as an untrusted boundary — but it must be declared, not inherited silently, and every agent-plane-side input crossing the plane validates at the boundary.

**Latency on high-frequency tools.** Filesystem reads and edits, which are microsecond in-process calls today, pay a cross-plane round-trip. M1 lets the data plane move while the body stays local, bounding the regression until M3 decides how much body logic moves.

**Split-definition drift.** A tool's control-plane projection and execution body can disagree (schema versus accepted arguments, render versus returned value) once they live on different planes. The registry's arg/output validation and the pure render contract carry the mismatch to a loud failure, but the two halves are now versioned together, not one object.

**Log-reconstruction completeness.** Execution-plane effects must return every event the log needs; a missed event breaks reconstructability silently. The cross-plane protocol must make missing-event states unrepresentable, or fail the call, rather than append a partial history.

**Lifecycle and tenant-shedding.** A wedged container or hung execution body must not hold the agent plane open; cancellation, grace, and reclamation are the same bounded-teardown problem `subagent-acp` and the workflow host solve today, now extended to a per-tenant container.