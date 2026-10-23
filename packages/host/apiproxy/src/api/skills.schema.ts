/**
 * skills domain zod schemas (names derived from map keys: skillListRequestSchema /
 * skillListValueSchema / skillInstallRequestSchema / skillInstallValueSchema /
 * skillRemoveRequestSchema / skillRemoveValueSchema / skillInstalledRequestSchema /
 * skillInstalledValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'
import type { SkillEntry, SkillEntryIssue, SkillTierEntry } from './skills.ts'

/** SkillEntry row of skill.list. */
export const skillEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  whenToUse: z.string().optional(),
  modelInvocable: z.boolean(),
}) satisfies z.ZodType<Wire<SkillEntry>>

/** skill.list request payload. */
export const skillListRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'skill.list'>>>

/** skill.list response value. */
export const skillListValueSchema = z.object({
  skills: z.array(skillEntrySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.list'>>>

/** A base64 payload, as a bundle field carries it. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

/** One coded reason a tier entry never reaches the catalog. */
export const skillEntryIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  line: z.number().optional(),
}) satisfies z.ZodType<Wire<SkillEntryIssue>>

/** One tier entry, loadable or not. */
export const skillTierEntrySchema = z.object({
  entry: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  loadable: z.boolean(),
  issues: z.array(skillEntryIssueSchema),
}) satisfies z.ZodType<Wire<SkillTierEntry>>

/** skill.install request payload: the base64 zip archive and whether it may replace an existing skill. */
export const skillInstallRequestSchema = z.object({
  zip: z.string().min(1).regex(BASE64, 'zip must carry a base64 zip archive'),
  replace: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'skill.install'>>>

/** skill.install response value. */
export const skillInstallValueSchema = z.object({
  name: z.string().min(1),
  directory: z.string().min(1),
  replaced: z.boolean(),
  files: z.array(z.string()),
  visible: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.install'>>>

/** skill.remove request payload: the frontmatter or directory name of the skill. */
export const skillRemoveRequestSchema = z.object({
  name: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'skill.remove'>>>

/** skill.remove response value. */
export const skillRemoveValueSchema = z.object({
  name: z.string().min(1),
  directory: z.string().min(1),
  visible: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.remove'>>>

/** skill.installed request payload: the caller's own tier is the whole scope. */
export const skillInstalledRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'skill.installed'>>>

/** skill.installed response value. */
export const skillInstalledValueSchema = z.object({
  directory: z.string().min(1),
  entries: z.array(skillTierEntrySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'skill.installed'>>>
