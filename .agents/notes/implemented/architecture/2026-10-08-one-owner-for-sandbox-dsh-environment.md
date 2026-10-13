# Agent Note: One owner for the sandbox DSH_* environment

Status: implemented

English | [中文](2026-10-08-one-owner-for-sandbox-dsh-environment.zh.md)

## Problem

Two execution entry points reach one tenant sandbox with different managed `DSH_*` environments. Observed on the trial deployment (`trial-tenant` / `trial-user`, session `session-9b5e8389-1176-42f1-b555-123dadcfe4d2`), the `bash` tool saw `DSH_CASE_ID`, `DSH_HOME=/root/.dsh`, `DSH_SESSION_ID=session-9b5e8389-…`, `DSH_SHELL=1`, `DSH_TENANT_ID`, `DSH_TOOL_EXEC_IDLE_MS=900000`, and `DSH_USER_ID`; a `run_code` program saw the same sandbox identity trio and the idle budget but `DSH_SESSION_ID=undefined`, no `DSH_HOME`, no `DSH_SHELL`, and `cwd=/opt/tool-exec`.

The two layers explain the split. The sandbox's own environment is fixed when the container starts — `container-docker` passes `-e DSH_CASE_ID/DSH_TENANT_ID/DSH_USER_ID` and the idle budget, `container-k8s` sets the same names on the Pod — and the in-container tool-exec server merges its process environment into every exec, so both entry points inherit those facts already. The per-execution harness facts are the ones that differ: only the shell path composed them, as `ctx.shellEnv.collect(execution)` → `ShellExecRequest.dshEnv` → `dsh-bash-local` merging into the spawn spec. The container code runtime composed `DSH_CODE_BRIDGE` alone, and nothing else was reachable from where it runs: `CodeRunRequest` carries a program, bindings, and a signal, and [`dsh-code-runtime`](../../../../packages/code-runtime/code-runtime/README.md) documents that runtimes know nothing about tools or sessions. Nothing in `packages/tenant/*` composed the harness group either — `dsh-subprocess-container` forwards `spec.env` — so `packages/tenant/*` only held the duplicated sandbox-scoped list that `container-docker` and `container-k8s` each build.

Session facts cannot move into the sandbox's own environment to close the gap. A sandbox is cached per (tenant, subject) with `sandboxCacheTtlMs` and serves any of that subject's sessions, so a session id placed there would be wrong for every session but one.

## Decision

`composeDshEnvironment(facts: { dshHome, sessionId? })` in [`@deepseek-ai/dsh-shell-env`](../../../../packages/shell/shell-env/README.md) is the only place the built-in keys are named, and `ctx.shellEnv` presents that one group through two entry points:

- `collect(execution)` renders it for one shell tool call — unchanged: the session is `execution.agent.session.header.id`, and contributor variables are merged on top.
- `collectSession()` renders it for a harness process the registry holds no `ToolExecution` for. Built-ins only, with the session read from `ctx.get('agents')?.currentInitiator()?.session.header.id` — the ambient authority the agent loop establishes for the current driver chain through `agents.withInitiator()`. The process environment is never a source: outside an initiator boundary the variable is absent, and a `currentInitiator()` that throws on a disposed registry yields no variable instead of failing the caller's run.

[`dsh-code-runtime-container`](../../../../packages/code-runtime/code-runtime-container/README.md) calls `collectSession()` on `ctx.get('shellEnv')` and merges the result with `DSH_CODE_BRIDGE` into its exec environment. It reads the registry through `ctx.get` rather than a declaration, so a composition without shell-env simply injects no managed group, and the runtime keeps no variable list of its own to drift from. `dsh-subprocess-container` stays a carrier: the caller's `spec.env` reaches the container exec unchanged.

## Alternatives considered

- **Add a `dshEnv` field to `CodeRunRequest`**, filled by whichever consumer runs the program: rejects — it puts harness environment vocabulary into the code-execution seam, requires every runtime and consumer to carry it, and still leaves any other caller of `ctx.codeRuntime` without the group, so the rule lands in consumers instead of the operation that makes the decision.
- **Compose the group in `dsh-subprocess-container`**, the tenant process provider: rejects — a subprocess provider forwards the caller's spec, holds no `ToolExecution`, would have to consult the ambient scope for every spawn, and a merge there could displace a consumer's deliberate `DSH_*` entry (`dsh-terminal-bash` composes `DSH_SHELL`, `DSH_SESSION_ID`, and `DSH_PTY_SESSION_ID` itself).
- **Compose in `@deepseek-ai/dsh-container` or `@deepseek-ai/dsh-subprocess`**: rejects — those layers sit below the harness, know no session, and cannot resolve the Harness home; they would either duplicate the facts or grow a configuration of their own.
- **Inject the group from the sandbox providers** (`container-docker`, `container-k8s` `sandboxEnv`): rejects — the sandbox outlives and is shared by many sessions of one subject, so a session-scoped value there is wrong for all but one of them, and a home value there would be a second source beside the registry's.
- **Give the container code runtime its own `dshHome` config with a default**: rejects — a second owner for the home value, and the registry already resolves it from `dshHome`/`$DSH_HOME`/`~/.dsh`.

## Consequences

- Both entry points inject one built-in group. `bash` additionally receives the sandbox's own identity variables, its consumer environment (`NO_COLOR`, `TERM`, `PAGER`, `GIT_PAGER`), and contributor variables; a `run_code` program receives the sandbox's identity variables, the managed group, and the bridge URL.
- Contributor variables stay shell-only. A contributor resolves from a `ToolExecution`, and `DSH_SESSION_JSONL` needs a session header for `sessionPersistence.locate()`, so `collectSession()` composes built-ins and a `run_code` program never receives them. Both packages record this as a Known Limitation.
- `DSH_SESSION_ID` reaches a program only inside an agent's driver chain — the case a model's `run_code` call is. A host-level or automation call to `ctx.codeRuntime.run` outside any initiator boundary gets home and shell identity but no session, absent rather than guessed.
- A program's process now carries harness facts it did not carry before. They are the sandbox's own deployment and session facts, already readable by any `bash` call in that sandbox; the managed namespace is a correlation convention rather than a credential, and `DSH_SESSION_JSONL` is a location hint.
- [`dsh-shell-env`](../../../../packages/shell/shell-env/README.md) takes a peer dependency on `@deepseek-ai/dsh-agent` for the ambient read; [`dsh-code-runtime-container`](../../../../packages/code-runtime/code-runtime-container/README.md) takes one on `@deepseek-ai/dsh-shell-env`.
- The session-identity rules for the shell path belong to the [session identity and log location Agent Note](../feature/2026-07-10-agent-session-identity-and-log-location.md), which stays current and now links here for the second entry point.
- The persistent-terminal path stays outside this ownership: [`dsh-terminal-bash`](../../../../packages/terminal/terminal-bash/README.md) composes its own `DSH_SHELL=1` and `DSH_SESSION_ID` from its spawn spec's owner and sets no `DSH_HOME`. Folding it in needs a registry entry point that takes an explicit agent, because a PTY spawn is not necessarily inside its owner's initiator chain and `collectSession()` reads only the ambient scope.

### Verification

- `packages/shell/shell-env/tests/shell-env.spec.ts` pins the owner: `composeDshEnvironment(facts)` equals the built-ins `collect(execution)` renders for the same facts, omits `DSH_SESSION_ID` without a session, and `collectSession()` equals it with the session taken from a stand-in ambient initiator, omits the variable with no agent service, no initiator, or a rejecting ambient read, and omits contributor variables beside a `collect()` that carries `DSH_SESSION_JSONL`. 19 of 19 pass.
- `packages/code-runtime/code-runtime-container/tests/runtime.spec.ts` runs a program that returns `process.env.DSH_HOME` under the real registry: the program reads the resolved home, the recorded exec environment holds exactly `composeDshEnvironment(facts)` plus `DSH_CODE_BRIDGE`, and a composition without shell-env holds the bridge URL alone. 9 of 9 pass.
- `packages/tenant/subprocess-container/tests/container.spec.ts` pins the carrier: a spawn spec whose `env` is `composeDshEnvironment(...)` reaches `containerRuntime.exec` unchanged. 6 of 6 pass.
- `pnpm exec tsc -b tsconfig.host.json` is clean.
- `pnpm run verify-export-jsdoc`, `verify-agent-note-format` (612 notes), `verify-agent-note-classification`, `verify-package-readme-limitations` (252 READMEs), and `verify-translation-pairing` on the four pairs this change touches pass.
- The suites that pin `collect()` directly — `dsh-tool-bash` and `dsh-bash-local` — are Windows-excluded by `vitest.config.ts` (they need a real POSIX shell), so they did not run on this host. The pwsh consumer of the same registry did: `packages/shell/tool-pwsh` passes 61 unit, 6 integration, and 1 loader test, plus 20 `tool-pwsh-persistent` and 18 `tool-bash-persistent` tests.
- Not verified here: the tenant stack's real composition. The tenant spine mounts `shell-env` and `code-runtime-container`, so both paths resolve one registry, and the sandbox providers inject the identity trio the trial deployment showed — but pinning the assembled tenant deployment needs the cluster, which this change does not touch.
