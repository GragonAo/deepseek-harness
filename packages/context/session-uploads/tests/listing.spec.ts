import { describe, expect, it } from 'vitest'
import { formatByteSize, renderUploads, type UploadEntry } from '../src/listing.ts'

const HEADER = 'Files the user attached to this session:'
const GUIDE = 'Read a file with the read tool when its contents matter; read_image reads an image.'

describe('formatByteSize', () => {
  it('keeps bytes below one kibibyte exact', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(1023)).toBe('1023 B')
  })

  it('rounds kibibytes and keeps one decimal above them', () => {
    expect(formatByteSize(1024)).toBe('1 KB')
    expect(formatByteSize(1536)).toBe('2 KB')
    expect(formatByteSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatByteSize(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(formatByteSize(1024 * 1024 * 1024)).toBe('1.0 GB')
  })
})

describe('renderUploads', () => {
  const entries: UploadEntry[] = [
    { name: '现场照片.jpg', type: 'file', size: 2 * 1024 * 1024 },
    { name: '供述材料.pdf', type: 'file', size: 300 * 1024 },
    { name: '无大小.txt', type: 'file' },
  ]

  it('lists absolute paths in name order with sizes', () => {
    expect(renderUploads(entries, '/sessions/session-1/uploads', 40)).toBe([
      HEADER,
      '- /sessions/session-1/uploads/供述材料.pdf — 300 KB',
      '- /sessions/session-1/uploads/无大小.txt',
      '- /sessions/session-1/uploads/现场照片.jpg — 2.0 MB',
      GUIDE,
    ].join('\n'))
  })

  it('marks a nested directory and drops entries that are neither file nor directory', () => {
    expect(renderUploads([
      { name: '证据', type: 'directory' },
      { name: 'fifo', type: 'other' },
    ], '/sessions/session-1/uploads', 40)).toBe([
      HEADER,
      '- /sessions/session-1/uploads/证据/',
      GUIDE,
    ].join('\n'))
  })

  it('tolerates a trailing separator on the directory', () => {
    expect(renderUploads([{ name: 'a.txt', type: 'file' }], '/w/uploads/', 40))
      .toContain('- /w/uploads/a.txt')
  })

  it('prints one separator on every host, so the same line replays everywhere', () => {
    expect(renderUploads([{ name: 'a.txt', type: 'file' }], 'C:\\ws\\session-1\\uploads\\', 40))
      .toContain('- C:/ws/session-1/uploads/a.txt')
  })

  it('renders nothing when there is nothing to list', () => {
    expect(renderUploads([], '/w/uploads', 40)).toBe('')
    expect(renderUploads([{ name: 'fifo', type: 'other' }], '/w/uploads', 40)).toBe('')
  })

  it('counts the entries a bounded listing leaves out', () => {
    const many: UploadEntry[] = [
      { name: 'a.txt', type: 'file' },
      { name: 'b.txt', type: 'file' },
      { name: 'c.txt', type: 'file' },
    ]
    expect(renderUploads(many, '/w/uploads', 1)).toBe([
      HEADER,
      '- /w/uploads/a.txt',
      '- 2 more entries are not listed.',
      GUIDE,
    ].join('\n'))
    expect(renderUploads(many, '/w/uploads', 2)).toContain('- 1 more entry is not listed.')
  })
})
