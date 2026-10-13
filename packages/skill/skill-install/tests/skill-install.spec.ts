import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { zipSync } from 'fflate'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as SkillTier from '@deepseek-ai/dsh-skill-tier'
import * as SkillInstall from '../src/index.ts'
import { SkillInstallError, type SkillInstallErrorCode } from '../src/index.ts'

const VALID = [
  '---',
  'name: imported-skill',
  'description: An imported skill.',
  '---',
  '',
  'Do the imported thing.',
  '',
].join('\n')

/** Build a zip bundle from a path-to-text map. */
function bundle(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, text] of Object.entries(files)) entries[path] = new TextEncoder().encode(text)
  return zipSync(entries)
}

interface Stack {
  readonly ctx: Context
  /** System tier directory the stack serves. */
  readonly skills: string
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * Boot the real skill stack over one system tier directory: the registry, the
 * filesystem provider that discovers a tier root, the ambient tier provider that
 * publishes it, and the installation service.
 */
async function boot(config: { maxBundleBytes?: number; maxExpandedBytes?: number } = {}): Promise<Stack> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-install-'))
  const skills = join(root, 'system', 'skills')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFilesystem, { includeDefaultRoots: false })
  await ctx.plugin(SkillTier, { systemSkillsDir: skills })
  await ctx.plugin(SkillInstall, config)
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, skills }
}

/** Read the tier directory, treating a directory a refused request never created as empty. */
async function tierEntries(stack: Stack): Promise<string[]> {
  try {
    return await readdir(stack.skills)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Capture the coded refusal of one request. */
async function refusal(run: () => Promise<unknown>): Promise<{
  code: SkillInstallErrorCode
  details: Record<string, unknown> | undefined
  message: string
}> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof SkillInstallError) {
      return { code: error.code, details: error.details, message: error.message }
    }
    throw error
  }
  throw new Error('the request was accepted')
}

describe('SkillInstallService', () => {
  it('installs a bundle, refreshes the cached catalog, and reports the skill as visible', async () => {
    const stack = await boot()
    // Warm the catalog before the upload, the way a running host holds it.
    expect(await stack.ctx.skills.list()).toEqual([])

    const result = await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) })

    expect(result).toMatchObject({
      tier: 'system',
      name: 'imported-skill',
      directory: join(stack.skills, 'imported-skill'),
      replaced: false,
      visible: true,
    })
    expect(result.files).toEqual(['SKILL.md'])
    expect(await readFile(join(stack.skills, 'imported-skill', 'SKILL.md'), 'utf8')).toBe(VALID)
    // The catalog a reader sees next comes from the refreshed revision.
    expect((await stack.ctx.skills.list()).map(skill => skill.name)).toEqual(['imported-skill'])
  })

  it('strips one wrapping directory, the layout an archive of a directory produces', async () => {
    const stack = await boot()
    const result = await stack.ctx.skillInstall.install({
      tier: 'system',
      bundle: bundle({ 'imported-skill-1.0/SKILL.md': VALID, 'imported-skill-1.0/notes.md': 'notes' }),
    })

    expect(result.name).toBe('imported-skill')
    expect(result.files).toEqual(['SKILL.md', 'notes.md'])
    expect(existsSync(join(stack.skills, 'imported-skill', 'notes.md'))).toBe(true)
  })

  it('refuses a same-named skill without replace and swaps it with replace', async () => {
    const stack = await boot()
    await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) })

    const refused = await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) }))
    expect(refused.code).toBe('skill-exists')
    expect(refused.details).toEqual({ directory: join(stack.skills, 'imported-skill') })

    const replaced = await stack.ctx.skillInstall.install({
      tier: 'system',
      replace: true,
      bundle: bundle({ 'SKILL.md': VALID.replace('An imported skill.', 'A replaced skill.') }),
    })
    expect(replaced.replaced).toBe(true)
    expect((await stack.ctx.skills.list())[0]?.description).toBe('A replaced skill.')
    // The swap leaves no staging or replaced directory behind.
    expect(await tierEntries(stack)).toEqual(['imported-skill'])
  })

  it('reports the frontmatter issue of an unloadable document instead of installing it', async () => {
    const stack = await boot()
    const broken = ['---', 'name: case-knowledge-base', 'description: A skill.', 'mainSteps: # note', '', 'Body.'].join('\n')

    const refused = await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': broken }) }))

    expect(refused.code).toBe('skill-invalid')
    const issues = refused.details?.issues as readonly { code: string; line?: number }[]
    expect(issues.map(issue => issue.code)).toEqual(['frontmatter-unterminated'])
    expect(issues[0]?.line).toBe(1)
    expect(await tierEntries(stack)).toEqual([])
  })

  it('names the invalid skill name of a document whose frontmatter is well formed', async () => {
    const stack = await boot()
    const refused = await refusal(async () => await stack.ctx.skillInstall.install({
      tier: 'system',
      bundle: bundle({ 'SKILL.md': VALID.replace('name: imported-skill', 'name: 概念知识规则') }),
    }))

    expect(refused.code).toBe('skill-invalid')
    const issues = refused.details?.issues as readonly { code: string; line?: number }[]
    expect(issues.map(issue => issue.code)).toEqual(['name-invalid'])
    expect(issues[0]?.line).toBe(2)
  })

  it('refuses a bundle with no root skill document or with several nested ones', async () => {
    const stack = await boot()
    expect((await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'README.md': 'no skill' }) }))).code)
      .toBe('bundle-invalid')
    expect((await refusal(async () => await stack.ctx.skillInstall.install({
      tier: 'system',
      bundle: bundle({ 'one/SKILL.md': VALID, 'two/SKILL.md': VALID }),
    }))).code).toBe('bundle-invalid')
  })

  it('refuses an entry that escapes the skill directory', async () => {
    const stack = await boot()
    const refused = await refusal(async () => await stack.ctx.skillInstall.install({
      tier: 'system',
      bundle: bundle({ 'SKILL.md': VALID, '../../escape.md': 'escape' }),
    }))

    expect(refused.code).toBe('bundle-unsafe-entry')
    expect(await tierEntries(stack)).toEqual([])
  })

  it('refuses a bundle over the expanded bound without writing anything', async () => {
    const stack = await boot({ maxExpandedBytes: 512 })
    const refused = await refusal(async () => await stack.ctx.skillInstall.install({
      tier: 'system',
      bundle: bundle({ 'SKILL.md': VALID, 'big.txt': 'x'.repeat(4096) }),
    }))

    expect(refused.code).toBe('bundle-too-large')
    expect(await tierEntries(stack)).toEqual([])
  })

  it('refuses bytes that are not a zip archive', async () => {
    const stack = await boot()
    expect((await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: new TextEncoder().encode('not a zip') }))).code)
      .toBe('bundle-invalid')
  })

  it('removes a skill by its frontmatter name as well as by its directory name', async () => {
    const stack = await boot()
    await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) })

    const removed = await stack.ctx.skillInstall.remove({ tier: 'system', name: 'imported-skill' })
    expect(removed).toMatchObject({
      name: 'imported-skill',
      directory: join(stack.skills, 'imported-skill'),
      visible: false,
    })
    expect(await stack.ctx.skills.list()).toEqual([])

    await mkdir(join(stack.skills, '概念知识库'), { recursive: true })
    await writeFile(join(stack.skills, '概念知识库', 'SKILL.md'), VALID)
    const byName = await stack.ctx.skillInstall.remove({ tier: 'system', name: 'imported-skill' })
    expect(byName.directory).toBe(join(stack.skills, '概念知识库'))
  })

  it('refuses removal of a skill that is not installed', async () => {
    const stack = await boot()
    expect((await refusal(async () =>
      await stack.ctx.skillInstall.remove({ tier: 'system', name: 'absent-skill' }))).code).toBe('skill-absent')
  })

  it('lists a tier directory with the coded issues of an unloadable entry', async () => {
    const stack = await boot()
    await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) })
    await mkdir(join(stack.skills, '知识库'), { recursive: true })
    await writeFile(join(stack.skills, '知识库', 'SKILL.md'), ['---', 'name: case-knowledge-base', '', 'Body.'].join('\n'))

    const listing = await stack.ctx.skillInstall.list({ tier: 'system' })

    expect(listing.directory).toBe(stack.skills)
    expect(listing.entries).toEqual([
      expect.objectContaining({ entry: 'imported-skill', name: 'imported-skill', loadable: true, issues: [] }),
      expect.objectContaining({
        entry: '知识库',
        loadable: false,
        issues: [expect.objectContaining({ code: 'frontmatter-unterminated' })],
      }),
    ])
  })

  it('refuses a tier the current scope does not publish', async () => {
    const stack = await boot()
    const refused = await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'case', bundle: bundle({ 'SKILL.md': VALID }) }))

    expect(refused.code).toBe('tier-unavailable')
    expect(refused.details).toEqual({ tier: 'case', kinds: ['system'] })
  })

  it('refuses an installation when no tier provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillInstall)
    cleanups.push(async () => { await ctx.fiber.dispose() })

    expect((await refusal(async () =>
      await ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) }))).code)
      .toBe('tier-unavailable')
  })

  it('rejects a non-positive bound at load', async () => {
    await expect(boot({ maxBundleBytes: 0 })).rejects.toThrow(/positive integers/)
  })

  it('lists an absent tier directory as empty and reports an entry with no readable document', async () => {
    const stack = await boot()
    expect(await stack.ctx.skillInstall.list({ tier: 'system' })).toMatchObject({ entries: [] })

    await mkdir(join(stack.skills, 'empty-bundle'), { recursive: true })
    await writeFile(join(stack.skills, 'notes.txt'), 'not a skill')
    await writeFile(join(stack.skills, 'README.md'), '# skills')

    const listing = await stack.ctx.skillInstall.list({ tier: 'system' })

    expect(listing.entries.map(entry => entry.entry).sort()).toEqual(['README.md', 'empty-bundle'])
    for (const entry of listing.entries) {
      expect(entry).toMatchObject({ loadable: false, issues: [expect.objectContaining({ code: 'frontmatter-missing' })] })
    }
  })

  it('removes a directory whose document it cannot read, named by its directory', async () => {
    const stack = await boot()
    await mkdir(join(stack.skills, 'broken-skill'), { recursive: true })
    await writeFile(join(stack.skills, 'broken-skill', 'SKILL.md'), ['---', 'name: broken-skill', '', 'Body.'].join('\n'))

    const result = await stack.ctx.skillInstall.remove({ tier: 'system', name: 'broken-skill' })

    expect(result).toMatchObject({ name: 'broken-skill', directory: join(stack.skills, 'broken-skill'), visible: false })
    expect(existsSync(join(stack.skills, 'broken-skill'))).toBe(false)
  })

  it('finds a skill by frontmatter name in a directory named otherwise, skipping flat files and unreadable documents', async () => {
    const stack = await boot()
    await mkdir(join(stack.skills, 'other-dir'), { recursive: true })
    await writeFile(
      join(stack.skills, 'other-dir', 'SKILL.md'),
      VALID.replace('name: imported-skill', 'name: scan-target'),
    )
    await mkdir(join(stack.skills, 'broken-dir'), { recursive: true })
    await writeFile(join(stack.skills, 'broken-dir', 'SKILL.md'), ['---', 'name: broken-dir', '', 'Body.'].join('\n'))
    await writeFile(join(stack.skills, 'flat-name.md'), VALID.replace('name: imported-skill', 'name: flat-target'))
    await mkdir(join(stack.skills, 'no-document-dir'), { recursive: true })

    const result = await stack.ctx.skillInstall.remove({ tier: 'system', name: 'scan-target' })

    expect(result).toMatchObject({ name: 'scan-target', directory: join(stack.skills, 'other-dir'), visible: false })
    expect(existsSync(join(stack.skills, 'other-dir'))).toBe(false)
    expect(existsSync(join(stack.skills, 'flat-name.md'))).toBe(true)
  })

  it('refuses a name two directories both register', async () => {
    const stack = await boot()
    for (const directory of ['one-dir', 'two-dir']) {
      await mkdir(join(stack.skills, directory), { recursive: true })
      await writeFile(join(stack.skills, directory, 'SKILL.md'), VALID)
    }

    const refused = await refusal(async () => await stack.ctx.skillInstall.remove({ tier: 'system', name: 'imported-skill' }))

    expect(refused.code).toBe('skill-ambiguous')
    expect(refused.details).toEqual({
      name: 'imported-skill',
      candidates: [join(stack.skills, 'one-dir'), join(stack.skills, 'two-dir')],
    })
  })

  it('refuses an empty bundle', async () => {
    const stack = await boot()
    const refused = await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: new Uint8Array(0) }))
    expect(refused.code).toBe('bundle-invalid')
  })

  it('refuses a bundle over the bundle byte bound', async () => {
    const stack = await boot({ maxBundleBytes: 64 })
    const refused = await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) }))
    expect(refused.code).toBe('bundle-too-large')
    expect(await tierEntries(stack)).toEqual([])
  })

  it('refuses a bundle whose declared entry sizes exceed the expanded bound', async () => {
    const stack = await boot({ maxExpandedBytes: 8 })
    const refused = await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) }))
    expect(refused.code).toBe('bundle-too-large')
    expect(refused.details).toMatchObject({ limit: 8 })
  })

  it('refuses a bundle holding more entries than the entry bound', async () => {
    const stack = await boot()
    const entries: Record<string, Uint8Array> = { 'SKILL.md': new TextEncoder().encode(VALID) }
    for (let index = 0; index < 2048; index += 1) entries[`filler-${index}.txt`] = new Uint8Array(0)

    const refused = await refusal(async () =>
      await stack.ctx.skillInstall.install({ tier: 'system', bundle: zipSync(entries) }))

    expect(refused.code).toBe('bundle-too-large')
    expect(refused.details).toEqual({ limit: 2048 })
  })

  it('skips a directory entry and refuses two entries that normalize to one path', async () => {
    const stack = await boot()
    const withDirectory = await stack.ctx.skillInstall.install({
      tier: 'system',
      bundle: zipSync({ 'SKILL.md': new TextEncoder().encode(VALID), 'assets/': new Uint8Array(0) }),
    })
    expect(withDirectory.files).toEqual(['SKILL.md'])

    const refused = await refusal(async () => await stack.ctx.skillInstall.install({
      tier: 'system',
      replace: true,
      bundle: zipSync({
        'SKILL.md': new TextEncoder().encode(VALID),
        'nested/note.md': new TextEncoder().encode('one'),
        'nested\\note.md': new TextEncoder().encode('two'),
      }),
    }))
    expect(refused.code).toBe('bundle-invalid')
    expect(refused.details).toEqual({ entry: 'nested/note.md' })
  })

  it('refuses an archive whose deflate stream is corrupt', async () => {
    const stack = await boot()
    const archive = bundle({ 'SKILL.md': `${VALID}${'padding '.repeat(80)}` })
    // A local header is 30 bytes plus the entry name, so the deflate stream of
    // `SKILL.md` starts at 38; corrupting its header makes inflate fail rather
    // than the archive parse.
    archive[38] = archive[38]! ^ 0xff
    archive[39] = archive[39]! ^ 0xff

    const refused = await refusal(async () => await stack.ctx.skillInstall.install({ tier: 'system', bundle: archive }))

    expect(refused.code).toBe('bundle-invalid')
    expect(await tierEntries(stack)).toEqual([])
  })

  it('addresses a skill placed by hand under a non-skill directory name by its frontmatter name', async () => {
    const stack = await boot()
    await mkdir(join(stack.skills, '知识库'), { recursive: true })
    await writeFile(
      join(stack.skills, '知识库', 'SKILL.md'),
      VALID.replace('name: imported-skill', 'name: case-knowledge-base'),
    )

    expect((await refusal(async () =>
      await stack.ctx.skillInstall.remove({ tier: 'system', name: '知识库' }))).code)
      .toBe('skill-absent')

    const removed = await stack.ctx.skillInstall.remove({ tier: 'system', name: 'case-knowledge-base' })

    expect(removed).toMatchObject({ name: 'case-knowledge-base', directory: join(stack.skills, '知识库'), visible: false })
  })

  it('installs an asset large enough to arrive in several chunks', async () => {
    const stack = await boot()
    const large = 'asset line\n'.repeat(20_000)

    const result = await stack.ctx.skillInstall.install({
      tier: 'system',
      bundle: bundle({ 'SKILL.md': VALID, 'assets/large.txt': large }),
    })

    expect(result.files).toEqual(['SKILL.md', 'assets/large.txt'])
    expect(await readFile(join(stack.skills, 'imported-skill', 'assets', 'large.txt'), 'utf8')).toBe(large)
  })

  it('surfaces a tier path that is not a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-install-'))
    const skills = join(root, 'system', 'skills')
    await mkdir(join(root, 'system'), { recursive: true })
    await writeFile(skills, 'not a directory')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillTier, { systemSkillsDir: skills })
    await ctx.plugin(SkillInstall)
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    await expect(ctx.skillInstall.list({ tier: 'system' })).rejects.toThrow(/ENOTDIR|not a directory/u)
  })

  it('leaves an unaddressable directory at the target in place when the swap cannot replace it', async () => {
    const stack = await boot()
    await mkdir(join(stack.skills, 'imported-skill'), { recursive: true })
    await writeFile(join(stack.skills, 'imported-skill', 'stray.txt'), 'not a skill')

    await expect(stack.ctx.skillInstall.install({ tier: 'system', bundle: bundle({ 'SKILL.md': VALID }) }))
      .rejects.toThrow()

    expect(existsSync(join(stack.skills, 'imported-skill', 'stray.txt'))).toBe(true)
  })
})
