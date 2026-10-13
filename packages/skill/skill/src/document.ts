/**
 * Skill document format: the frontmatter fence, the YAML metadata block, and
 * the markdown instruction body one skill file carries.
 *
 * This module owns that format for the whole seam. Providers read bytes and
 * call {@link readSkillDocument}; every rejection names its cause as a coded
 * issue with a line in the file it came from, so a skill that never becomes
 * loadable is diagnosable from the log rather than from its absence.
 *
 * @module @deepseek-ai/dsh-skill/document
 */

import { parse as parseYaml } from 'yaml'
import type { SkillInvocationPolicy } from './index.ts'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER_FENCE = '---'

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Why a skill document cannot become a loadable skill. */
export type SkillDocumentIssueCode =
  | 'frontmatter-missing'
  | 'frontmatter-unterminated'
  | 'frontmatter-invalid-yaml'
  | 'frontmatter-not-mapping'
  | 'name-missing'
  | 'name-invalid'
  | 'description-missing'
  | 'unsupported-field'
  | 'field-not-boolean'

/** One reason a skill document was rejected, located in the file it came from. */
export interface SkillDocumentIssue {
  /** Machine-readable cause; the vocabulary a caller reports and switches on. */
  readonly code: SkillDocumentIssueCode
  /** Human-readable explanation naming the offending field or fence. */
  readonly message: string
  /** 1-based line in the document, present whenever the cause has a location. */
  readonly line?: number
}

/** Parsed frontmatter plus the instruction body of one skill document. */
export interface SkillDocument {
  /** Validated kebab-case name the skill registers under. */
  readonly name: string
  /** Routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Parsed optional metadata object from the frontmatter. */
  readonly metadata?: Record<string, unknown>
  /** Instruction body after the frontmatter fence, trimmed. */
  readonly body: string
}

/** Result of reading one skill document. */
export type SkillDocumentResult =
  | { readonly ok: true; readonly document: SkillDocument }
  | { readonly ok: false; readonly issues: readonly SkillDocumentIssue[] }

/** One frontmatter fence location inside a document. */
interface FrontmatterSpan {
  /** Offset of the opening fence's line. */
  readonly openLine: number
  /** Offset of the YAML block's first character. */
  readonly yamlStart: number
  /** Offset of the closing fence's line. */
  readonly yamlEnd: number
  /** Offset of the instruction body's first character. */
  readonly bodyStart: number
}

/**
 * Read one skill document: validate its frontmatter and return the metadata and
 * body, or every reason it cannot be loaded. No filesystem access happens here,
 * so a caller may validate a document before it is written anywhere.
 * @param raw - the complete skill file text.
 * @returns the parsed document, or the coded issues that reject it.
 */
export function readSkillDocument(raw: string): SkillDocumentResult {
  const span = locateFrontmatter(raw)
  if ('code' in span) return { ok: false, issues: [span] }
  const yaml = raw.slice(span.yamlStart, span.yamlEnd)
  let data: unknown
  try {
    data = parseYaml(yaml)
  } catch (error: unknown) {
    return { ok: false, issues: [yamlIssue(error, span)] }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      ok: false,
      issues: [{
        code: 'frontmatter-not-mapping',
        line: span.openLine,
        message: 'frontmatter must be a YAML mapping of fields',
      }],
    }
  }
  return readFields(data as Record<string, unknown>, raw, span)
}

/**
 * Locate the frontmatter fences of a document.
 * @param raw - the complete skill file text.
 * @returns the fence offsets, or the issue that makes the frontmatter unreadable.
 */
function locateFrontmatter(raw: string): FrontmatterSpan | SkillDocumentIssue {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== FRONTMATTER_FENCE) {
    return {
      code: 'frontmatter-missing',
      line: 1,
      message: `a skill file must open with a line containing exactly "${FRONTMATTER_FENCE}"`,
    }
  }
  const yamlStart = firstLineEnd + 1
  let lineStart = yamlStart
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === FRONTMATTER_FENCE) {
      return {
        openLine: 1,
        yamlStart,
        yamlEnd: lineStart,
        bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1,
      }
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  return {
    code: 'frontmatter-unterminated',
    line: 1,
    message: `frontmatter opens at line 1 and no later line contains exactly "${FRONTMATTER_FENCE}"`,
  }
}

/**
 * Map one YAML parse failure onto its issue, resolving the parser's line
 * position against the document.
 * @param error - the error the YAML parser threw.
 * @param span - the frontmatter fences the parse ran between.
 * @returns the coded issue for this failure.
 */
function yamlIssue(error: unknown, span: FrontmatterSpan): SkillDocumentIssue {
  const position = (error as { linePos?: readonly { line: number }[] }).linePos?.[0]
  return {
    code: 'frontmatter-invalid-yaml',
    ...position === undefined ? {} : { line: span.openLine + position.line },
    message: error instanceof Error ? error.message.split('\n')[0] ?? String(error) : String(error),
  }
}

/**
 * Validate the frontmatter fields every loadable skill must carry.
 * @param data - the parsed frontmatter mapping.
 * @param raw - the complete skill file text, for body extraction.
 * @param span - the frontmatter fences the fields came from.
 * @returns the parsed document, or every issue the fields raise.
 */
function readFields(data: Record<string, unknown>, raw: string, span: FrontmatterSpan): SkillDocumentResult {
  const yaml = raw.slice(span.yamlStart, span.yamlEnd)
  const issues: SkillDocumentIssue[] = []
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined) {
    issues.push({
      code: 'name-missing',
      line: fieldLine(yaml, span, 'name') ?? span.openLine,
      message: 'frontmatter requires a non-empty string "name"',
    })
  } else if (!isSkillName(name)) {
    issues.push({
      code: 'name-invalid',
      line: fieldLine(yaml, span, 'name') ?? span.openLine,
      message: `name ${JSON.stringify(name)} must match ${String(SKILL_NAME)}`,
    })
  }
  if (description === undefined) {
    issues.push({
      code: 'description-missing',
      line: fieldLine(yaml, span, 'description') ?? span.openLine,
      message: 'frontmatter requires a non-empty string "description"',
    })
  }
  const policy = readInvocation(data, yaml, span, issues)
  if (issues.length > 0 || name === undefined || description === undefined || policy === undefined) {
    return { ok: false, issues }
  }
  const whenToUse = optionalString(data, 'whenToUse')
  const metadata = optionalMetadata(data)
  return {
    ok: true,
    document: {
      name,
      description,
      ...whenToUse === undefined ? {} : { whenToUse },
      invocation: policy,
      ...metadata === undefined ? {} : { metadata },
      body: raw.slice(span.bodyStart).trim(),
    },
  }
}

/**
 * Resolve the invocation policy from the canonical frontmatter fields.
 * @param data - the parsed frontmatter mapping.
 * @param yaml - the raw frontmatter block, for issue lines.
 * @param span - the frontmatter fences the fields came from.
 * @param issues - collector receiving every policy issue.
 * @returns the resolved policy, or `undefined` when a field was rejected.
 */
function readInvocation(
  data: Record<string, unknown>,
  yaml: string,
  span: FrontmatterSpan,
  issues: SkillDocumentIssue[],
): SkillInvocationPolicy | undefined {
  const legacy: readonly (readonly [string, string])[] = [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]
  for (const [field, canonical] of legacy) {
    if (Object.hasOwn(data, field)) {
      issues.push({
        code: 'unsupported-field',
        line: fieldLine(yaml, span, field) ?? span.openLine,
        message: `frontmatter field "${field}" is unsupported; use "${canonical}"`,
      })
    }
  }
  const disableModelInvocation = booleanField(data, 'disable-model-invocation', yaml, span, issues)
  const userInvocable = booleanField(data, 'user-invocable', yaml, span, issues)
  if (issues.length > 0) return undefined
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/**
 * Read one optional boolean field in the frontmatter's accepted spellings.
 * @param data - the parsed frontmatter mapping.
 * @param key - the field name.
 * @param yaml - the raw frontmatter block, for issue lines.
 * @param span - the frontmatter fences the fields came from.
 * @param issues - collector receiving a rejected value.
 * @returns the field's value, or `undefined` when it is absent or rejected.
 */
function booleanField(
  data: Record<string, unknown>,
  key: string,
  yaml: string,
  span: FrontmatterSpan,
  issues: SkillDocumentIssue[],
): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
      default:
        break
    }
  }
  issues.push({
    code: 'field-not-boolean',
    line: fieldLine(yaml, span, key) ?? span.openLine,
    message: `frontmatter field "${key}" must be a boolean`,
  })
  return undefined
}

/**
 * Resolve the line of one frontmatter field within its document.
 * @param yaml - the raw frontmatter block.
 * @param span - the frontmatter fences the block came from.
 * @param key - the field name to locate.
 * @returns the 1-based document line, or `undefined` when the field has no own line.
 */
function fieldLine(yaml: string, span: FrontmatterSpan, key: string): number | undefined {
  const lines = yaml.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith(`${key}:`) && !line.trimStart().startsWith('#')) {
      return span.openLine + index + 1
    }
  }
  return undefined
}

/**
 * Read a non-empty string frontmatter field.
 * @param data - the parsed frontmatter mapping.
 * @param key - the field name.
 * @returns the field value, or `undefined` when absent or empty.
 */
function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read an optional non-empty string frontmatter field.
 * @param data - the parsed frontmatter mapping.
 * @param key - the field name.
 * @returns the field value when present and non-empty.
 */
function optionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the optional provider-agnostic metadata object.
 * @param data - the parsed frontmatter mapping.
 * @returns the metadata mapping when the field is an object.
 */
function optionalMetadata(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}
