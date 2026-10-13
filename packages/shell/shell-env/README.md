# @deepseek-ai/dsh-shell-env

English | [中文](README.zh.md)

The tool-independent managed environment plugin: owns the `ctx.shellEnv` registry of trusted, per-execution `DSH_*` variables and is the one owner of that variable group, so every harness process started in a sandbox takes the group from here — the model-facing shell tools (`dsh-tool-bash`, `dsh-tool-pwsh`) collect it into every shell call's environment and the container code runtime hands it to every `run_code` program. Built-in shell facts (`DSH_HOME`, `DSH_SHELL=1`, `DSH_SESSION_ID`) are owned by the registry itself; other plugins register additional enumerable facts with effect-scoped disposal, and duplicate ownership or undeclared runtime keys fail loudly.

The package root exports the Cordis plugin contract (`name`, `inject`, `Config`, `apply`) plus the `ShellEnvRegistry` service class, the `composeDshEnvironment` built-in composer, and their types; consumers use `ctx.shellEnv` after loading this plugin.

## Config

```yaml
- id: shell-env
  name: '@deepseek-ai/dsh-shell-env'
  config:
    dshHome: C:\Users\me\.dsh   # default: $DSH_HOME, then ~/.dsh
```

## Managed environment

Every foreground and background model shell call receives a newly collected trusted `DSH_*` environment. `DSH_HOME` is the absolute Harness home resolved by [`@deepseek-ai/dsh-home-paths`](../../util/home-paths/README.md) (`dshHome` config, then ambient `$DSH_HOME`, then `~/.dsh`) and `DSH_SHELL=1` identifies the managed child. Agent calls additionally receive `DSH_SESSION_ID=agent.session.header.id`; when the active persistence seam locates a JSONL artifact they also receive `DSH_SESSION_JSONL=<absolute target path>`. The JSONL path is a location hint: it may not exist before the first flush or contain the current buffered turn, and it is not an authorization credential.

`ctx.shellEnv` owns collection. Other plugins can register an effect-scoped contributor with a stable name, declared keys/descriptions, and `resolve(execution: ToolExecution)`; duplicate ownership and undeclared runtime keys fail loudly, while `list()` enumerates declarations without executing providers. Harness built-ins reserve `DSH_HOME`, `DSH_SHELL`, and `DSH_SESSION_ID`; this plugin's persistence translator owns `DSH_SESSION_JSONL` by reading the backend-neutral `sessionPersistence.locate()` seam.

The built-in part of the group is composed by `composeDshEnvironment(facts)`, the only place those keys are named, and `ctx.shellEnv` presents it through two entry points. `collect(execution)` renders it for one shell tool call, adding contributor variables. `collectSession()` renders it for a harness process this registry holds no `ToolExecution` for — a container code-runtime program — taking the session from the ambient agent-initiator scope the agent loop establishes for the current driver chain: it neither reads the process environment nor consults contributors, so `DSH_SESSION_ID` is absent outside an initiator boundary or once the agent service is disposed, and `DSH_SESSION_JSONL` is absent on that path. `composeDshEnvironment` is exported so a caller that must recognize or assert the group composes it rather than restating the key list.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-env'

export const inject = ['shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'deployment-region',
    variables: { DSH_DEPLOYMENT_REGION: { description: 'Current deployment region.' } },
    resolve: execution => execution.agent === undefined ? {} : { DSH_DEPLOYMENT_REGION: 'cn-north' },
  })
}
```

The overlay is computed from the current `ToolExecution` and passed through the dedicated `ShellExecRequest.dshEnv` channel. The local executors remove all inherited `DSH_*` before merging that snapshot, so nested harnesses and concurrent parent/child agents cannot leak stale identities. `process.env` is never modified. The shell tools' descriptions teach the generic `$DSH_*` convention rather than naming persistence-specific variables or adding a permanent system-prompt section.

## Model Experience

Indirectly, through the shell tools (`dsh-tool-bash`, `dsh-tool-pwsh`), which collect this registry's managed `DSH_*` snapshot into every shell-tool call, and through the container code runtime, which hands the same snapshot to every `run_code` program, so a program reads the sandbox's `$DSH_*` facts without a shell round-trip.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **`list()` enumerates contributor-declared variables only** — registry-owned built-ins (`DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`) are not included, so diagnostics, prompt, or UI code must not treat `list()` as an exhaustive environment catalog.
- **Contributor variables reach shell tool calls only** — a contributor resolves from a `ToolExecution`, which `collectSession()` does not hold, so a container code-runtime program never receives `DSH_SESSION_JSONL`; the two entry points agree on the built-in group.
