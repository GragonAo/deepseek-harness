/**
 * The management method table: one entry per operation the `/admin` prefix
 * serves, each pairing its payload schema with the call it makes. A method's
 * wire name is the operation's own name under the prefix
 * (`POST /admin/tenants.create`), so the carrier never invents a second
 * vocabulary for the same operation.
 *
 * Tenant methods run against `ctx.tenantAdmin`; skill methods run against
 * `ctx.skillInstall`, which a composition mounts only when it serves skill
 * bundles. A skill method called without that service raises
 * `skill-install-unavailable` rather than appearing to exist and doing nothing.
 * @module @deepseek-ai/dsh-tenant-admin-http/operations
 */

import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { SKILL_TIER_KINDS } from '@deepseek-ai/dsh-skill'
import type { SkillInstallService } from '@deepseek-ai/dsh-skill-install'
import type { Tenant } from '@deepseek-ai/dsh-tenant'
import type { TenantAdmin } from '@deepseek-ai/dsh-tenant-admin'
import { AdminRequestError } from './errors.ts'
import type { TenantAdminView } from './types.ts'

/**
 * Map one tenant record to its wire view, normalizing the optional fields a
 * client reads as present values and copying the member list.
 * @param tenant - the record as the registry holds it.
 * @returns the view served to a management client.
 */
export function tenantAdminView(tenant: Tenant): TenantAdminView {
  return {
    id: String(tenant.id),
    name: tenant.name,
    dataRoot: tenant.dataRoot,
    workspaceRoot: tenant.workspaceRoot,
    ...(tenant.toolsRoot !== undefined ? { toolsRoot: tenant.toolsRoot } : {}),
    enabled: tenant.enabled ?? true,
    ...(tenant.network !== undefined ? { network: tenant.network } : {}),
    members: [...(tenant.members ?? [])],
  }
}

/** Services a management method runs against. */
export interface AdminServices {
  /** Tenant registry administration. */
  readonly admin: TenantAdmin
  /** Skill bundle installation, present when `@deepseek-ai/dsh-skill-install` is mounted. */
  readonly skillInstall?: SkillInstallService | undefined
}

/**
 * One management operation as the dispatcher sees it. `invoke` validates the
 * wire payload through the same schema the document publishes, so validation
 * has exactly one home and a payload that reaches a service is typed.
 */
export interface AdminOperation {
  /** Payload schema; the OpenAPI document publishes it and `invoke` validates with it. */
  readonly schema: z.ZodType
  /** Response value schema, published by the OpenAPI document. */
  readonly value: z.ZodType
  /**
   * Validate one wire payload and run the management call.
   * @param services - the services this surface serves methods against.
   * @param payload - the parsed request body, unvalidated.
   * @returns the method's wire value.
   */
  readonly invoke: (services: AdminServices, payload: unknown) => Promise<unknown>
}

/** Build one table entry, keeping its payload type local to its own method. */
function adminOperation<P, V>(
  schema: z.ZodType<P>,
  value: z.ZodType<V>,
  run: (services: AdminServices, payload: P) => V | Promise<V>,
): AdminOperation {
  return {
    schema,
    value,
    invoke: async (services: AdminServices, payload: unknown): Promise<unknown> =>
      await run(services, schema.parse(payload)),
  }
}

/** Resolve the bundle installation service a skill method cannot run without. */
function skillInstallOf(services: AdminServices): SkillInstallService {
  if (services.skillInstall === undefined) {
    throw new AdminRequestError(
      503,
      'skill-install-unavailable',
      'skills.* methods need @deepseek-ai/dsh-skill-install mounted',
    )
  }
  return services.skillInstall
}

const tenantView = z.object({
  id: z.string(),
  name: z.string(),
  dataRoot: z.string(),
  workspaceRoot: z.string(),
  toolsRoot: z.string().optional(),
  enabled: z.boolean(),
  network: z.enum(['none', 'internal']).optional(),
  members: z.array(z.string()),
})

const membersValue = z.object({ members: z.array(z.string()) })

const tenantIdPayload = z.object({ id: z.string().min(1) })

const skillTier = z.enum(SKILL_TIER_KINDS)

const skillTierEntryView = z.object({
  entry: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  loadable: z.boolean(),
  issues: z.array(z.object({
    code: z.string(),
    message: z.string(),
    line: z.number().optional(),
  })),
})

const skillListingValue = z.object({
  tier: skillTier,
  directory: z.string(),
  entries: z.array(skillTierEntryView),
})

const skillInstallValue = z.object({
  tier: skillTier,
  name: z.string(),
  directory: z.string(),
  replaced: z.boolean(),
  files: z.array(z.string()),
  visible: z.boolean(),
})

const skillRemoveValue = z.object({
  tier: skillTier,
  name: z.string(),
  directory: z.string(),
  visible: z.boolean(),
})

/** A base64 payload, as the zip field carries it. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

/** Every method the management surface serves, keyed by its wire name. */
export const OPERATIONS: Record<string, AdminOperation> = {
  'tenants.list': adminOperation(z.object({}), z.object({ items: z.array(tenantView) }), services => ({
    items: services.admin.list().map(tenantAdminView),
  })),

  'tenants.get': adminOperation(tenantIdPayload, tenantView, (services, payload) =>
    tenantAdminView(services.admin.get(payload.id))),

  'tenants.create': adminOperation(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    dataRoot: z.string().min(1),
    workspaceRoot: z.string().min(1),
    toolsRoot: z.string().min(1).optional(),
    network: z.enum(['none', 'internal']).optional(),
    members: z.array(z.string().min(1)).optional(),
  }), tenantView, async (services, payload) => tenantAdminView(await services.admin.create({
    id: payload.id,
    name: payload.name,
    dataRoot: payload.dataRoot,
    workspaceRoot: payload.workspaceRoot,
    ...(payload.toolsRoot !== undefined ? { toolsRoot: payload.toolsRoot } : {}),
    ...(payload.network !== undefined ? { network: payload.network } : {}),
    ...(payload.members !== undefined ? { members: payload.members } : {}),
  }))),

  'tenants.update': adminOperation(tenantIdPayload.extend({
    name: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    toolsRoot: z.string().min(1).optional(),
    network: z.enum(['none', 'internal']).optional(),
  }), tenantView, async (services, payload) => tenantAdminView(await services.admin.update(payload.id, {
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(payload.workspaceRoot !== undefined ? { workspaceRoot: payload.workspaceRoot } : {}),
    ...(payload.toolsRoot !== undefined ? { toolsRoot: payload.toolsRoot } : {}),
    ...(payload.network !== undefined ? { network: payload.network } : {}),
  }))),

  'tenants.enable': adminOperation(tenantIdPayload, tenantView, async (services, payload) =>
    tenantAdminView(await services.admin.enable(payload.id))),

  'tenants.disable': adminOperation(tenantIdPayload, tenantView, async (services, payload) =>
    tenantAdminView(await services.admin.disable(payload.id))),

  'tenants.remove': adminOperation(tenantIdPayload.extend({ purge: z.boolean().optional() }),
    z.object({ removed: z.literal(true) }), async (services, payload) =>
      await services.admin.remove(payload.id, payload.purge ?? false)),

  'members.list': adminOperation(tenantIdPayload, membersValue, (services, payload) => ({
    members: services.admin.membersList(payload.id),
  })),

  'members.add': adminOperation(tenantIdPayload.extend({ subject: z.string().min(1) }), membersValue,
    async (services, payload) => ({ members: await services.admin.membersAdd(payload.id, payload.subject) })),

  'members.remove': adminOperation(tenantIdPayload.extend({ subject: z.string().min(1) }), membersValue,
    async (services, payload) => ({ members: await services.admin.membersRemove(payload.id, payload.subject) })),

  'users.ensure': adminOperation(z.object({ subject: z.string().min(1) }),
    z.object({ root: z.string() }), async (services, payload) =>
      await services.admin.usersEnsure(payload.subject)),

  'skills.list': adminOperation(z.object({ tier: skillTier }), skillListingValue, async (services, payload) => {
    const listing = await skillInstallOf(services).list({ tier: payload.tier })
    return {
      tier: listing.tier,
      directory: listing.directory,
      entries: listing.entries.map(entry => ({ ...entry, issues: [...entry.issues] })),
    }
  }),

  'skills.upload': adminOperation(z.object({
    tier: skillTier,
    zip: z.string().min(1).regex(BASE64, 'zip must carry a base64 zip archive'),
    replace: z.boolean().optional(),
  }), skillInstallValue, async (services, payload) => {
    const installed = await skillInstallOf(services).install({
      tier: payload.tier,
      bundle: Buffer.from(payload.zip, 'base64'),
      ...(payload.replace !== undefined ? { replace: payload.replace } : {}),
    })
    return { ...installed, files: [...installed.files] }
  }),

  'skills.remove': adminOperation(z.object({ tier: skillTier, name: z.string().min(1) }),
    skillRemoveValue, async (services, payload) =>
      await skillInstallOf(services).remove({ tier: payload.tier, name: payload.name })),
}
