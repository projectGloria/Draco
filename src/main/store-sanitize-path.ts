const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*]/g
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function toFolderName(name: string): string {
  const printable = Array.from(name.trim()).filter((ch) => (ch.codePointAt(0) ?? 0) >= 32).join('')
  const cleaned = printable.replace(ILLEGAL_PATH_CHARS, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').slice(0, 60).trim()
  if (!cleaned) return 'Untitled'
  return RESERVED_DEVICE_NAMES.test(cleaned) ? cleaned + '_' : cleaned
}
