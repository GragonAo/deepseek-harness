# Agent Note: The container execution side names the ripgrep binary

Status: implemented

English | [中文](2026-10-08-container-execution-side-ripgrep-path.zh.md)

> The packaged binary and the argv-vector spawn of [Packaged ripgrep spawn for glob/grep](2026-08-01-packaged-ripgrep-search.md) remain the co-located deployment's mechanism; the alternative that note rejected — an injectable binary path — returns as a deployment `Config` field for an execution side that is a container.

## Problem

`glob` and `grep` spawn the ripgrep binary their own process resolves: the `@vscode/ripgrep` platform package from this workspace's `node_modules`, or the executable's `-rg` sidecar in a single-file runtime. A tenant stack puts the execution side in a container — `ctx.subprocess` is `packages/tenant/subprocess-container`, which forwards the argv vector into the sandbox — so both halves of that assumption fail. The tenant host image runs the bundled app (`Dockerfile.tenant` packs `packages/tenant/tenant-app/lib/bin.js`), where `import('@vscode/ripgrep')` stays a dynamic import inside a bundle: a bundler inlines no optional platform package, and pnpm hoists no dependency to the root `node_modules`, so the image carries no such package and the resolution rejects. And where the import does resolve, its value is an absolute path in the HOST's filesystem, while the spawn happens in the container, whose filesystem has no such path. Both reach the model as `Error: glob could not start its search command (ripgrep launch failed)` with `SEARCH_FAILED`, and no resolution performed here can be right for a filesystem this process cannot see.

## Decision

`@deepseek-ai/dsh-tool-fs-search` accepts an optional `ripgrepPath` config field: the absolute path of the ripgrep binary on the execution side. A configured value reaches `resolveRgPath()` unchanged — no packaged resolution, no existence probe — and becomes `argv[0]` of the spawn. Omitted, the packaged resolution runs exactly as before, lazily and memoized per process, so a co-located deployment keeps its behavior and its messages.

The config field is the whole mechanism: which binary the execution side carries is a fact of that side's image, and [the plugin-config rule](../../../../AGENTS.md#conventions) puts deployment-varying values in validated `Config`. The load-time check covers a blank value, a misconfiguration visible without the other filesystem; whether a path is usable is answered only by the execution side, so an unusable one fails each call as `SEARCH_FAILED` whose message names the configured path. That failure stays per-call for the same reason the packaged resolution already is: a deployment fault must not take down the composition.

The tenant stack wires both ends. `packages/tenant/tenant-app/src/spine.ts` sets `ripgrepPath: '/usr/local/bin/rg'`, and the tool-exec image installs the npm platform package `@vscode/ripgrep-linux-x64`'s `bin/rg` at that path during its build, asserting `test -x /usr/local/bin/rg && /usr/local/bin/rg --version` before the build can succeed. The install reaches no GitHub release — only the npm registry the build already uses for `esbuild`.

## Alternatives considered

- **Align the two filesystems so the packaged path also exists in the container.** Rejected: it repairs one of the two failures and leaves the host-absolute path of the other handed to a spawn in the container. It also makes two independently built images depend on identical layout at identical character positions, which nothing enforces, so the first base-image or dependency change restores the failure.
- **Rewrite the host path into a container path inside `subprocess-container`.** Rejected: that adapter forwards a generic argv vector for every tool, so the rewrite would have to recognize ripgrep by argument position — one search tool's deployment detail inside the seam all tools share, and a rule that misfires on an argument that merely looks like a path.
- **Fall back to an `rg` found on the container's `PATH`.** Rejected: the search would then depend on whichever binary the image happens to carry, and its absence reads as an unexplained `ENOENT`; an explicit path is the same decision with its dependency stated.
- **Embed the binary in the harness core.** Rejected: a binary must reach the execution side's filesystem to be executed there, so a core copy still needs the image to hold it, or a transfer per spawn, while the core grows a platform-specific artifact for one tool package's need.

## Consequences

- A co-located deployment is unchanged: no `ripgrepPath`, the same lazy packaged resolution, the same memoized failure, and the same `SEARCH_FAILED` text.
- The tenant sandbox's `glob`/`grep` spawn `/usr/local/bin/rg`, and the host-side `@vscode/ripgrep` copy in that deployment is never executed. Only the execution side's binary runs, so the image's pinned version and the host dependency range need not agree.
- A misconfigured `ripgrepPath` is a runtime search failure rather than a load failure, so a deployment learns about it from its first tool call; the message names the path, which is what makes it actionable.
- The tool-exec image grows a ripgrep install built through the same `NPM_REGISTRY` build argument the `esbuild` step already uses, and its build fails rather than shipping a sandbox with no search binary.

### Verification

- `packages/fs/tool-fs-search/tests/tools.spec.ts` asserts that both tools spawn the configured path as `argv[0]`, that an unconfigured deployment still spawns the packaged `rgPath`, that a failed launch reports `SEARCH_FAILED` naming the configured path while the unconfigured message carries no path, and that a blank `ripgrepPath` fails the plugin load.
- `packages/fs/tool-fs-search/tests/rg-path.spec.ts` resolves a configured path while `@vscode/ripgrep` is mocked to throw at evaluation, so the configured branch provably never touches the packaged module.
- `pnpm exec tsc -b tsconfig.host.json` is clean and the package suite passes (`pnpm exec vitest run packages/fs/tool-fs-search/tests`).
- The tool-exec Dockerfile asserts `/usr/local/bin/rg --version` at build time, so an image without the binary cannot build; a session on a deployed tenant stack is what confirms `glob`/`grep` answer from the sandbox instead of failing with `SEARCH_FAILED`.
