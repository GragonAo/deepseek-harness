import { defineConfig } from 'tsdown'

/**
 * Inlining the workflow runtime pulls `@deepseek-ai/dsh-llm` (for `assertNever`),
 * whose `attribution.ts` reads its own `../package.json` at module load via
 * `createRequire(import.meta.url)`. That runtime require breaks once the bundle
 * is relocated (a temp file locally, `-e` or a mounted file in the container).
 * The worker never makes an LLM provider request, so the product `version` is
 * dead there: inline a synthetic value and let tree-shaking drop the
 * `node:module` import entirely.
 */
const inlineAttributionVersion = {
  name: 'inline-llm-attribution-version',
  transform(code: string, id: string) {
    if (!id.includes('llm') || !id.includes('attribution')) return undefined
    return code.replace(
      "createRequire(import.meta.url)('../package.json') as { version: string }",
      "{ version: '0.0.0-inlined' } as { version: string }",
    )
  },
}

/**
 * Build the engine and the container worker separately so each inlines shared
 * modules; a multi-entry build creates an unlisted chunk. The container worker
 * is ESM because the host runs it as `node --input-type=module -e <bundle>`
 * inside the tool-exec container, which ships no tsx or source tree.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/container-worker.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [inlineAttributionVersion],
    // The tool-exec container ships no node_modules, so the worker must inline
    // the whole workflow runtime (runWorkerSession and every @deepseek-ai/* it
    // reaches); node: builtins stay external to the container's own Node.
    deps: {
      alwaysBundle: [/@deepseek-ai\//],
    },
  },
])
