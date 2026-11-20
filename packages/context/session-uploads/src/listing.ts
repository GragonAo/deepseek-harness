/**
 * Model-facing rendering of one session's uploaded files.
 * @module @deepseek-ai/dsh-session-uploads/listing
 */

/** One child of the uploads directory, reduced to what the listing prints. */
export interface UploadEntry {
  /** Basename of the child inside the uploads directory. */
  readonly name: string
  /** Whether the child holds file content, is a directory, or is neither. */
  readonly type: 'file' | 'directory' | 'other'
  /** Byte size the filesystem backend reported, when it reported one. */
  readonly size?: number | undefined
}

/** Uploads directory recorded on every assembly when the deployment does not override it. */
export const DEFAULT_DIRECTORY = 'uploads'

/** Entries printed per assembly when the deployment does not override it. */
export const DEFAULT_MAX_ENTRIES = 40

/**
 * A byte count in the unit a reader judges file size by.
 * @param bytes - non-negative byte count.
 * @returns the count with a binary unit suffix, at most one decimal place.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * The inventory a model reads to learn which files the user attached and where
 * they are, so it opens one instead of asking what was uploaded or searching
 * the workspace for it.
 *
 * Entries print in name order, so a session that gains a file changes one line
 * of the snapshot rather than reordering it. The listing states absolute paths,
 * because the model passes them straight to the file tools. It renders to the
 * empty string when the directory holds nothing, which contributes no runtime
 * context at all.
 * @param entries - children of the uploads directory, in backend order.
 * @param directory - path of the uploads directory as the model addresses it, without a trailing separator.
 * @param maxEntries - maximum entries to print before summarizing the rest as a count.
 * @returns the listing text, or `''` when there is nothing to list.
 */
export function renderUploads(
  entries: readonly UploadEntry[],
  directory: string,
  maxEntries: number,
): string {
  // `/` joins the parts on every host: a Windows provider reports `\`, and a
  // path that reaches a shell command or a file tool the same way on both
  // platforms is one less thing the model has to translate. Node accepts it.
  const base = directory.replace(/\\/g, '/').replace(/\/+$/, '')
  // Code-unit order, so one directory prints the same lines on every host. The
  // subtraction is a total comparator without a branch for equal names, which a
  // single directory listing cannot produce.
  const listed = entries
    .filter(entry => entry.type !== 'other')
    .sort((left, right) => Number(left.name > right.name) - Number(left.name < right.name))
  if (listed.length === 0) return ''
  const shown = listed.slice(0, maxEntries)
  const lines = shown.map((entry) => {
    const path = `${base}/${entry.name}${entry.type === 'directory' ? '/' : ''}`
    return entry.size === undefined ? `- ${path}` : `- ${path} — ${formatByteSize(entry.size)}`
  })
  const hidden = listed.length - shown.length
  if (hidden > 0) lines.push(`- ${hidden} more ${hidden === 1 ? 'entry is' : 'entries are'} not listed.`)
  return [
    'Files the user attached to this session:',
    ...lines,
    'Read a file with the read tool when its contents matter; read_image reads an image.',
  ].join('\n')
}
