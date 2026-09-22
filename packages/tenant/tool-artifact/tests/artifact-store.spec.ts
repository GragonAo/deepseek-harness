import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_KINDS,
  TAG_CLOSE,
  TAG_OPEN,
  addressContainerPath,
  attachmentTag,
  deliveryName,
  formatStamp,
  isInside,
  kindForExtension,
  publicPathFor,
  sanitizeSegment,
  splitExtension,
} from '../src/artifact-store.ts'
import type { Mount } from '../src/artifact-store.ts'

const mounts: readonly Mount[] = [
  { container: '/workspace', host: '/srv/cases/acme/users/user-1' },
  { container: '/shared', host: '/srv/cases/acme/shared' },
  { container: '/global', host: '/var/lib/dsh/users/user-1' },
]

describe('kindForExtension', () => {
  it('maps known extensions case-insensitively', () => {
    expect(kindForExtension('.docx')).toBe('docs')
    expect(kindForExtension('.XLSX')).toBe('sheets')
    expect(kindForExtension('.svg')).toBe('images')
  })

  it('files an unmapped extension under other', () => {
    expect(kindForExtension('')).toBe('other')
    expect(kindForExtension('.bin')).toBe('other')
  })

  it('offers every kind it can produce in the tool schema', () => {
    expect(ARTIFACT_KINDS).toContain(kindForExtension('.zip'))
    expect(ARTIFACT_KINDS).toContain('other')
  })
})

describe('splitExtension', () => {
  it('splits a normal file name', () => {
    expect(splitExtension('report.DOCX')).toEqual({ stem: 'report', ext: '.docx' })
  })

  it('keeps a dotfile and an extensionless name whole', () => {
    expect(splitExtension('.env')).toEqual({ stem: '.env', ext: '' })
    expect(splitExtension('report')).toEqual({ stem: 'report', ext: '' })
    expect(splitExtension('trailing.')).toEqual({ stem: 'trailing.', ext: '' })
  })
})

describe('sanitizeSegment', () => {
  it('keeps letters, digits, and the safe punctuation of a CJK title', () => {
    expect(sanitizeSegment('孙策案件审查报告-2026_v2', 'x')).toBe('孙策案件审查报告-2026_v2')
  })

  it('neutralizes traversal, separators, spaces, and URL-significant punctuation', () => {
    expect(sanitizeSegment('../../etc/passwd', 'x')).toBe('etc_passwd')
    expect(sanitizeSegment('a b#c?d', 'x')).toBe('a_b_c_d')
    expect(sanitizeSegment('..', 'x')).toBe('x')
    expect(sanitizeSegment('   ', 'x')).toBe('x')
  })

  it('bounds the length so a long title cannot exhaust the file-name limit', () => {
    expect(sanitizeSegment('a'.repeat(300), 'x')).toHaveLength(80)
  })
})

describe('addressContainerPath', () => {
  it('addresses an absolute path against its owning mount', () => {
    const addressed = addressContainerPath('/workspace/out/report.docx', '/workspace', mounts)
    expect(addressed?.mount.container).toBe('/workspace')
    expect(addressed?.relativePath).toBe('out/report.docx')
  })

  it('resolves a relative path against the working directory', () => {
    expect(addressContainerPath('report.docx', '/workspace/out', mounts)?.relativePath).toBe('out/report.docx')
  })

  it('picks the mount that owns the path, not a sibling that shares a prefix', () => {
    expect(addressContainerPath('/shared/a.txt', '/workspace', mounts)?.mount.container).toBe('/shared')
    expect(addressContainerPath('/workspaces/a.txt', '/workspace', mounts)).toBeNull()
  })

  it('refuses a path outside every mount, including an attempt to climb out', () => {
    expect(addressContainerPath('/etc/passwd', '/workspace', mounts)).toBeNull()
    expect(addressContainerPath('../../etc/passwd', '/workspace', mounts)).toBeNull()
  })
})

describe('isInside', () => {
  it('accepts the root and a descendant', () => {
    expect(isInside('/srv/cases/acme', '/srv/cases/acme')).toBe(true)
    expect(isInside('/srv/cases/acme', '/srv/cases/acme/users/user-1/a.txt')).toBe(true)
  })

  it('rejects a sibling whose name extends the root', () => {
    expect(isInside('/srv/cases/acme', '/srv/cases/acme-2/a.txt')).toBe(false)
  })
})

describe('delivery addressing', () => {
  it('builds a same-origin path under the route prefix', () => {
    expect(publicPathFor('/media', ['acme', 'user-1', 'docs', 'a.docx'])).toBe('/media/acme/user-1/docs/a.docx')
    expect(publicPathFor('/media/', ['acme', 'a.docx'])).toBe('/media/acme/a.docx')
  })

  it('carries the path and nothing else in the delivery tag', () => {
    const tag = attachmentTag('/media/acme/user-1/docs/a.docx')
    expect(tag).toBe(`${TAG_OPEN} /media/acme/user-1/docs/a.docx ${TAG_CLOSE}`)
    expect(tag).not.toContain('http')
  })
})

describe('deliveryName', () => {
  it('names the first attempt after the timestamp and stems later ones', () => {
    expect(deliveryName('20260921_153012', 'report', '.docx', 1)).toBe('20260921_153012_report.docx')
    expect(deliveryName('20260921_153012', 'report', '.docx', 3)).toBe('20260921_153012_report_3.docx')
  })
})

describe('formatStamp', () => {
  it('formats local time as a sortable stamp', () => {
    expect(formatStamp(new Date(2026, 8, 21, 15, 30, 12))).toBe('20260921_153012')
  })
})
