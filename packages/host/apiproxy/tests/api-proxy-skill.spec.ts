/**
 * Skill tier methods over the real installation seam. The ambient tier roots
 * decide where a write lands, so these run inside a real user scope instead of a
 * stubbed service: the point under test is that the caller's own tier is the
 * only writable one, and that a refused bundle reports the seam's own reason.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { apply as applySkillInstall } from '@deepseek-ai/dsh-skill-install'
import { apply as applySkillTier } from '@deepseek-ai/dsh-skill-tier'
import { UserId, runWithUser } from '@deepseek-ai/dsh-tenant'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { RpcError, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`skill-${String(nextRpc++)}`), payload }
}

/** Base64 zip carrying the given bundle-relative files. */
function bundle(files: Record<string, string>): string {
  const zipped = zipSync(Object.fromEntries(
    Object.entries(files).map(([path, body]) => [path, strToU8(body)]),
  ))
  return Buffer.from(zipped).toString('base64')
}

/** A bundle holding one loadable skill document. */
function skillBundle(name: string, extra: Record<string, string> = {}): string {
  return bundle({ 'SKILL.md': `---\nname: ${name}\ndescription: 测试技能\n---\n\n正文\n`, ...extra })
}

function valueOf<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function errorOf<T>(response: RpcResponse<T>): RpcError {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

interface Harness {
  api: ApiProxy
  ctx: Context
  usersRoot: string
  systemRoot: string
}

/** Compose the API over the real skill registry, install seam, and tier resolver. */
async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apiproxy-skill-'))
  const usersRoot = join(root, 'users')
  const systemRoot = join(root, 'system')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(UserQuestionService)
  applySkillTier(ctx, { usersRoot, systemSkillsDir: systemRoot })
  applySkillInstall(ctx)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
  })
  return { api, ctx, usersRoot, systemRoot }
}

/** Run one request inside an authenticated user scope, the way a tenant carrier does. */
function asUser<T>(user: string, run: () => Promise<T>): Promise<T> {
  return Promise.resolve(runWithUser(UserId(user), run))
}

describe('skill.install', () => {
  it('installs into the calling user tier and reports the written directory', async () => {
    const { api, ctx, usersRoot } = await harness()
    try {
      const value = await asUser('investigator-1', () => api.skills.install(request({
        zip: skillBundle('case-notes'),
      })).then(valueOf))
      expect(value.name).toBe('case-notes')
      expect(value.directory).toBe(join(usersRoot, 'investigator-1', 'skills', 'case-notes'))
      expect(value.replaced).toBe(false)
      expect(value.files).toEqual(['SKILL.md'])
      expect(existsSync(join(value.directory, 'SKILL.md'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('writes the user tier even when the payload names another one', async () => {
    const { api, ctx, usersRoot, systemRoot } = await harness()
    try {
      const payload = { zip: skillBundle('redirected'), tier: 'system' }
      const value = await asUser('investigator-1', () => api.skills.install(request(payload)).then(valueOf))
      expect(value.directory.startsWith(join(usersRoot, 'investigator-1'))).toBe(true)
      expect(existsSync(join(systemRoot, 'redirected'))).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a bundle with no skill document, reporting the seam reason', async () => {
    const { api, ctx } = await harness()
    try {
      const error = await asUser('investigator-1', () => api.skills.install(request({
        zip: bundle({ 'README.md': 'no skill here\n' }),
      })).then(errorOf))
      expect(error.code).toBe('skill-rejected')
      if (error.code !== 'skill-rejected') throw new Error('unreachable')
      expect(error.details.reason).toBe('bundle-invalid')
      expect(error.details.issues).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses an unloadable skill document, carrying its coded issues', async () => {
    const { api, ctx } = await harness()
    try {
      const error = await asUser('investigator-1', () => api.skills.install(request({
        zip: bundle({ 'SKILL.md': '---\ndescription: 没有名字\n---\n\n正文\n' }),
      })).then(errorOf))
      expect(error.code).toBe('skill-rejected')
      if (error.code !== 'skill-rejected') throw new Error('unreachable')
      expect(error.details.reason).toBe('skill-invalid')
      expect(error.details.issues.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses an existing name unless the request allows replacement', async () => {
    const { api, ctx } = await harness()
    try {
      await asUser('investigator-1', () => api.skills.install(request({ zip: skillBundle('twice') })).then(valueOf))
      const refused = await asUser('investigator-1', () => api.skills.install(request({
        zip: skillBundle('twice'),
      })).then(errorOf))
      expect(refused.code).toBe('skill-rejected')
      if (refused.code !== 'skill-rejected') throw new Error('unreachable')
      expect(refused.details.reason).toBe('skill-exists')

      const replaced = await asUser('investigator-1', () => api.skills.install(request({
        zip: skillBundle('twice'),
        replace: true,
      })).then(valueOf))
      expect(replaced.replaced).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses to install without a user scope: no tier is writable', async () => {
    const { api, ctx } = await harness()
    try {
      const error = await api.skills.install(request({ zip: skillBundle('scopeless') })).then(errorOf)
      expect(error.code).toBe('skill-rejected')
      if (error.code !== 'skill-rejected') throw new Error('unreachable')
      expect(error.details.reason).toBe('tier-unavailable')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the missing installation seam rather than failing silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-apiproxy-skill-'))
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(UserQuestionService)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
      cwd: root,
    })
    try {
      const error = await api.skills.install(request({ zip: skillBundle('nothing') })).then(errorOf)
      expect(error).toEqual({
        code: 'internal',
        message: 'skill installation is absent: no composition mounts @deepseek-ai/dsh-skill-install',
        details: {},
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('skill.installed and skill.remove', () => {
  it('lists the calling user tier and removes one installed skill', async () => {
    const { api, ctx, usersRoot } = await harness()
    try {
      await asUser('investigator-1', () => api.skills.install(request({ zip: skillBundle('listed') })).then(valueOf))

      const listing = await asUser('investigator-1', () => api.skills.installed(request({})).then(valueOf))
      expect(listing.directory).toBe(join(usersRoot, 'investigator-1', 'skills'))
      expect(listing.entries).toEqual([
        { entry: 'listed', name: 'listed', description: '测试技能', loadable: true, issues: [] },
      ])

      const removed = await asUser('investigator-1', () => api.skills.remove(request({ name: 'listed' })).then(valueOf))
      expect(removed.name).toBe('listed')
      expect(existsSync(removed.directory)).toBe(false)

      const again = await asUser('investigator-1', () => api.skills.remove(request({ name: 'listed' })).then(errorOf))
      expect(again.code).toBe('skill-rejected')
      if (again.code !== 'skill-rejected') throw new Error('unreachable')
      expect(again.details.reason).toBe('skill-absent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists an entry that never loads with the reasons it is skipped', async () => {
    const { api, ctx, usersRoot } = await harness()
    try {
      await asUser('investigator-1', () => api.skills.install(request({
        zip: bundle({ 'SKILL.md': 'no frontmatter at all\n' }),
      })).then(errorOf))
      // The refused install wrote nothing, so stage the broken entry the way a hand-placed file arrives.
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const directory = join(usersRoot, 'investigator-1', 'skills', 'broken')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'SKILL.md'), 'no frontmatter at all\n')

      const listing = await asUser('investigator-1', () => api.skills.installed(request({})).then(valueOf))
      const entry = listing.entries.find(candidate => candidate.entry === 'broken')
      expect(entry?.loadable).toBe(false)
      expect(entry?.issues.length).toBeGreaterThan(0)
      expect(typeof entry?.issues[0]?.code).toBe('string')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses to list without a user scope', async () => {
    const { api, ctx } = await harness()
    try {
      const error = await api.skills.installed(request({})).then(errorOf)
      expect(error.code).toBe('skill-rejected')
      if (error.code !== 'skill-rejected') throw new Error('unreachable')
      expect(error.details.reason).toBe('tier-unavailable')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
