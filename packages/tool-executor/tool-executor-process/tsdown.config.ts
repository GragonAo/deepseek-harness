import { defineConfig } from 'tsdown'

/**
 * Node-only backend. The execution worker builds as its own CJS entry
 * (mirroring dsh-code-runtime-worker-thread's worker): path-loaded by the
 * provider next to this module, inlining the body registry and protocol loop.
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
    entry: { worker: 'lib/types/worker.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])