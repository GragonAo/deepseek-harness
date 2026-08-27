/**
 * Declarative tool-manifest file format and parser.
 *
 * A tool manifest is one YAML document that declares a tool as pure data — a
 * name, a description, flat string parameters, and a fixed subprocess executor
 * with an argv template. No manifest may carry executable code: the loader
 * maps the declarative fields onto one fixed harness executor, never onto a
 * user-supplied function. Parameters are restricted to flat string scalars
 * because they are substituted into argv (`$field`) and have no richer shape.
 *
 * @module @deepseek-ai/dsh-tools-manifest/manifest
 */

import { parse as parseYaml } from 'yaml'

/** One flat string parameter the manifest declares for `$field` argv templating. */
export interface ToolManifestParameter {
  readonly type: 'string'
  readonly description?: string
  readonly required?: true
}

/** The command executor: a fixed executable resolved in the tenant container. */
export interface ToolManifestExecutor {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

/** A parsed, validated tool manifest. */
export interface ToolManifest {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, ToolManifestParameter>>
  readonly executor: ToolManifestExecutor
  readonly timeoutMs?: number
}

const TOOL_NAME = /^[a-z][a-z0-9_-]*$/

/**
 * Parse and validate one manifest document.
 * @param text - the YAML document text.
 * @param file - the file path for diagnostic messages.
 * @returns the validated manifest.
 */
export function parseManifest(text: string, file: string): ToolManifest {
  const record = asMapping(parseYaml(text), file, '')
  const name = stringField(record, 'name', file)
  if (!TOOL_NAME.test(name)) {
    throw fail(file, 'name', 'must be a kebab-case tool name (lowercase letters, digits, `-`, `_`)')
  }
  const description = stringField(record, 'description', file).trim()
  if (description === '') throw fail(file, 'description', 'must be a non-empty string')
  const parameters = parseParameters(record.parameters, file)
  const executor = parseExecutor(record.executor, file)
  const timeoutMs = record.timeoutMs === undefined ? undefined : positiveNumber(record.timeoutMs, file, 'timeoutMs')
  return { name, description, parameters, executor, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

function parseParameters(value: unknown, file: string): Readonly<Record<string, ToolManifestParameter>> {
  if (value === undefined) return {}
  const mapping = asMapping(value, file, 'parameters')
  const out: Record<string, ToolManifestParameter> = {}
  for (const [key, spec] of Object.entries(mapping)) {
    const entry = asMapping(spec, file, `parameters.${key}`)
    const type = entry.type
    if (type !== 'string') {
      throw fail(file, `parameters.${key}.type`, 'must be "string" (only flat string scalars are supported)')
    }
    out[key] = {
      type: 'string',
      ...(entry.description === undefined ? {} : { description: stringField(entry, 'description', file, `parameters.${key}.description`) }),
      ...(entry.required === undefined ? {} : { required: true }),
    }
  }
  return out
}

function parseExecutor(value: unknown, file: string): ToolManifestExecutor {
  const record = asMapping(value, file, 'executor')
  const command = stringField(record, 'command', file, 'executor.command').trim()
  if (command === '') throw fail(file, 'executor.command', 'must be a non-empty executable name or path')
  const args = record.args === undefined ? [] : stringArray(record.args, file, 'executor.args')
  const cwd = record.cwd === undefined ? undefined : stringField(record, 'cwd', file, 'executor.cwd')
  const env = record.env === undefined ? undefined : stringRecord(record.env, file, 'executor.env')
  return { command, args, ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }) }
}

/** @returns the value narrowed to a mapping. */
function asMapping(value: unknown, file: string, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(file, field, field === '' ? 'root must be a YAML mapping' : 'must be a YAML mapping')
  }
  return value as Record<string, unknown>
}

/** @returns the string value of `field` on `record`. */
function stringField(record: Record<string, unknown>, field: string, file: string, label = field): string {
  const value = record[field]
  if (typeof value !== 'string') throw fail(file, label, 'must be a string')
  return value
}

/** @returns the string-array value of `record.args`. */
function stringArray(value: unknown, file: string, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw fail(file, label, 'must be an array of strings')
  }
  return value as string[]
}

/** @returns the string-record value of `record.env`. */
function stringRecord(value: unknown, file: string, label: string): Record<string, string> {
  const record = asMapping(value, file, label)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') throw fail(file, `${label}.${key}`, 'must be a string')
    out[key] = item
  }
  return out
}

/** @returns a positive-finite-number value. */
function positiveNumber(value: unknown, file: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw fail(file, label, 'must be a positive finite number')
  }
  return value
}

/** @returns the tagged parse failure. */
function fail(file: string, field: string, message: string): Error {
  const at = field === '' ? '' : ` field "${field}"`
  return new Error(`${file}:${at === '' ? ' ' : `${at}`} ${message}`)
}
