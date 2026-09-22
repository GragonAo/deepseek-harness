/**
 * tenant-admin domain zod schemas (names derived from map keys:
 * tenantAdminListViewSchema / tenantAdminGetRequestSchema / tenantAdminViewSchema / …).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { TenantAdminCreatePayload, TenantAdminUpdatePayload, TenantAdminView } from './tenant-admin.ts'

/** Wire view of one tenant record. */
export const tenantAdminViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dataRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  toolsRoot: z.string().optional(),
  enabled: z.boolean(),
  network: z.union([z.literal('none'), z.literal('internal')]).optional(),
  members: z.array(z.string()),
}) satisfies z.ZodType<Wire<TenantAdminView>>

/** tenant.admin.list request payload. */
export const tenantAdminListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.list'>>>

/** tenant.admin.list response value. */
export const tenantAdminListValueSchema = z.object({
  items: z.array(tenantAdminViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'tenant.admin.list'>>>

/** tenant.admin.get request payload. */
export const tenantAdminGetRequestSchema = z.object({ id: z.string().min(1) }) satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.get'>>>

/** One tenant-admin record response value (get/create/update/enable/disable). */
export const tenantAdminRecordValueSchema = tenantAdminViewSchema satisfies z.ZodType<Wire<ResponseValue<'tenant.admin.get'>>>

/** tenant.admin.create request payload. */
export const tenantAdminCreateRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dataRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  toolsRoot: z.string().optional(),
  network: z.union([z.literal('none'), z.literal('internal')]).optional(),
  members: z.array(z.string()).optional(),
}) satisfies z.ZodType<Wire<TenantAdminCreatePayload>> satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.create'>>>

/** tenant.admin.update request payload. */
export const tenantAdminUpdateRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  workspaceRoot: z.string().optional(),
  toolsRoot: z.string().optional(),
  network: z.union([z.literal('none'), z.literal('internal')]).optional(),
}) satisfies z.ZodType<Wire<{ id: string } & TenantAdminUpdatePayload>> satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.update'>>>

/** Shared single-id request payload (enable/disable/remove/members.list). */
const tenantAdminIdRequestSchema = z.object({ id: z.string().min(1) })

/** tenant.admin.enable request payload. */
export const tenantAdminEnableRequestSchema = tenantAdminIdRequestSchema satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.enable'>>>

/** tenant.admin.disable request payload. */
export const tenantAdminDisableRequestSchema = tenantAdminIdRequestSchema satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.disable'>>>

/** tenant.admin.remove request payload. */
export const tenantAdminRemoveRequestSchema = z.object({
  id: z.string().min(1),
  purge: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.remove'>>>

/** tenant.admin.remove response value. */
export const tenantAdminRemoveValueSchema = z.object({ removed: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'tenant.admin.remove'>>>

/** tenant.admin.members.list request payload. */
export const tenantAdminMembersListRequestSchema = tenantAdminIdRequestSchema satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.members.list'>>>

/** tenant.admin.members.list response value. */
export const tenantAdminMembersListValueSchema = z.object({ members: z.array(z.string()) }) satisfies z.ZodType<Wire<ResponseValue<'tenant.admin.members.list'>>>

/** tenant.admin.members.add request payload. */
export const tenantAdminMembersAddRequestSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.members.add'>>>

/** tenant.admin.members.add response value. */
export const tenantAdminMembersAddValueSchema = z.object({ members: z.array(z.string()) }) satisfies z.ZodType<Wire<ResponseValue<'tenant.admin.members.add'>>>

/** tenant.admin.members.remove request payload. */
export const tenantAdminMembersRemoveRequestSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.members.remove'>>>

/** tenant.admin.members.remove response value. */
export const tenantAdminMembersRemoveValueSchema = z.object({ members: z.array(z.string()) }) satisfies z.ZodType<Wire<ResponseValue<'tenant.admin.members.remove'>>>

/** tenant.admin.users.ensure request payload. */
export const tenantAdminUsersEnsureRequestSchema = z.object({ subject: z.string().min(1) }) satisfies z.ZodType<Wire<RequestPayload<'tenant.admin.users.ensure'>>>

/** tenant.admin.users.ensure response value. */
export const tenantAdminUsersEnsureValueSchema = z.object({ root: z.string() }) satisfies z.ZodType<Wire<ResponseValue<'tenant.admin.users.ensure'>>>
