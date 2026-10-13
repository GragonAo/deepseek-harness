import { defineConfig } from 'tsdown'

/** Build the package root and optional invariant companion as independent bundles. */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // Keep one copy of the module-level partition reader; a second copy would
    // read a different Cordis service store than the consumers'.
    deps: { neverBundle: ['@deepseek-ai/dsh-partition-scope'] },
  },
])
