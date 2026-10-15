import { escapeWindowsDeviceName } from './engine/naming.ts'

const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*]/g

export function toFolderName(name: string): string {
  const printable = Array.from(name.trim()).filter((ch) => (ch.codePointAt(0) ?? 0) >= 32).join('')
  const cleaned = printable.replace(ILLEGAL_PATH_CHARS, '').replace(/\s+/g, ' ').slice(0, 60).replace(/[.\s]+$/, '').trim()
  if (!cleaned) return 'Untitled'
  return escapeWindowsDeviceName(cleaned)
}
