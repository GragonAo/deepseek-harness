/**
 * Declarative tool-manifest loader.
 *
 * Walks the ambient tool-tier directories supplied by the multi-tenant
 * carrier's `ctx.toolTiers` service and registers each manifest as a tool in
 * the created agent's own scope, using the tier rank so the case tier shadows
 * the user-global tier, which shadows the system tier. A manifest is pure
 * data: the loader maps it onto exactly one fixed subprocess executor family
 * (`executor.command` plus an `$field` argv template) and never interprets the
 * manifest as code. Execution routes through `ctx.subprocess`, which in the
 * multi-tenant carrier is the container provider, so a tenant-authored
 * manifest command runs inside its own tenant container and cannot escape
 * isolation.
 *
 * @module @deepseek-ai/dsh-tools-manifest
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { defineTool, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseManifest, type ToolManifest } from './manifest.ts'

/** Cordis plugin name. */
export const name = 'tools-manifest'

/** Services the loader needs to register and run declarative tools. */
export const inject = ['tools', 'subprocess']

/** Declarative tool-loader configuration. */
export interface Config {
  /** Bounded stdout/stderr tail (bytes) captured per manifest-tool call. */
  maxOutputBytes?: number
  /** Process-tree termination grace (milliseconds) for each manifest-tool call. */
  graceMs?: number
  /** Working directory when a manifest omits `executor.cwd` (container deployments set `/workspace`). */
  defaultCwd?: string
}

/** Validate the loader configuration. */
export const Config: Schema<Config> = z.object({
  maxOutputBytes: z.natural().min(1),
  graceMs: z.natural().min(1),
  defaultCwd: z.string(),
})

interface ResolvedConfig {
  maxOutputBytes: number
  graceMs: number
  defaultCwd: string
}

/**
 * Register the `agent/created` listener that maps the current (tenant, user)
 * tier directories into ranked tools for every new agent.
 * @param ctx - Cordis context carrying `tools`, `subprocess`, and (optionally) the ambient `toolTiers` provider.
 * @param config - output and grace bounds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    maxOutputBytes: config.maxOutputBytes ?? 1_000_000,
    graceMs: config.graceMs ?? 5_000,
    defaultCwd: config.defaultCwd ?? '/workspace',
  }
  // `subprocess` is a declared inject; `ctx.get` reads the service store so a
  // direct (non-Loader) construction resolves it too. Absent it, fail loud.
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new Error('@deepseek-ai/dsh-tools-manifest requires ctx.subprocess (load a subprocess provider, e.g. @deepseek-ai/dsh-subprocess-container)')
  }
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    registerTierTools(ctx, agent, resolved, subprocess)
  }, { global: true }), 'tools-manifest: agent tier tool registration')
}

/**
 * Resolve the tier directories for the request currently in scope and register
 * their manifests into the agent's own scope, system → user-global → case, so
 * the nearest (lowest) rank wins a shared name. Registrations unwind with the
 * agent scope's disposal.
 */
function registerTierTools(ctx: Context, agent: Agent, config: ResolvedConfig, subprocess: SubprocessRuntime): void {
  const roots = ctx.get('toolTiers')?.roots() ?? []
  const ordered = [...roots].sort((a, b) => b.rank - a.rank)
  for (const root of ordered) {
    for (const definition of loadManifests(root.path, config, subprocess)) {
      agent.ctx.tools.register(definition, root.rank)
    }
  }
}

/**
 * Read, parse, and build every manifest file in one tier directory. A missing
 * directory is an empty tier; a duplicate manifest name within the directory
 * or an invalid document fails loud. A tier's restriction document is not a
 * manifest and is skipped here.
 */
function loadManifests(dir: string, config: ResolvedConfig, subprocess: SubprocessRuntime): ToolDefinition[] {
  const seen = new Set<string>()
  const definitions: ToolDefinition[] = []
  for (const file of listManifestFiles(dir)) {
    if (isRestrictionDocument(file)) continue
    const manifest = parseManifest(readFileSync(file, 'utf8'), file)
    if (seen.has(manifest.name)) {
      throw new Error(`${dir}: duplicate manifest tool name ${JSON.stringify(manifest.name)}`)
    }
    seen.add(manifest.name)
    definitions.push(toDefinition(manifest, config, subprocess))
  }
  return definitions
}

/**
 * Whether a tier directory entry is the document
 * `@deepseek-ai/dsh-tools-restriction` reserves for one tier's tool
 * restriction. It declares no tool, so parsing it as a manifest would fail
 * every tier that restricts tools; the restriction plugin reads it instead.
 */
function isRestrictionDocument(file: string): boolean {
  const base = basename(file)
  return base === 'restriction.yaml' || base === 'restriction.yml'
}

/** @returns sorted `*.yaml` / `*.yml` file paths under `dir`, empty when the directory is absent. */
function listManifestFiles(dir: string): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')))
    .map(entry => join(dir, entry.name))
    .sort()
}

/**
 * Build the one fixed executor family for a manifest: a subprocess in the
 * tenant container whose argv is the manifest's template with `$field`
 * placeholders substituted from the validated string arguments.
 */
function toDefinition(manifest: ToolManifest, config: ResolvedConfig, subprocess: SubprocessRuntime): ToolDefinition {
  return defineTool({
    name: manifest.name,
    description: manifest.description,
    parameters: manifest.parameters as ParameterSchemaSpec,
    ...(manifest.timeoutMs !== undefined ? { timeoutMs: manifest.timeoutMs } : {}),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    async execute(args, exec) {
      const argv = manifest.executor.args.map(arg => arg.replace(
        /\$([A-Za-z0-9_]+)/g,
        (_all, capture: string) => String((args as Record<string, string>)[capture] ?? ''),
      ))
      const executable = await subprocess.resolveExecutable(manifest.executor.command, manifest.executor.env, exec.signal)
      const handle = subprocess.spawn({
        argv: [executable, ...argv],
        cwd: manifest.executor.cwd ?? config.defaultCwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: config.maxOutputBytes },
          stderr: { maxBytes: config.maxOutputBytes },
        },
        graceMs: config.graceMs,
        signal: exec.signal,
        ...(manifest.executor.env !== undefined ? { env: manifest.executor.env } : {}),
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      if (outcome.exitCode !== 0) {
        throw new Error(`tool "${manifest.name}" exited ${outcome.exitCode}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
      }
      return stdout
    },
  })
}
