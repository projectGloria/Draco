import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FormatSpec } from './args.ts'

export type SavedFormat = Exclude<FormatSpec, { kind: 'index' }>
export interface Preferences { format?: SavedFormat; dir?: string }

export function savedFormat(value: unknown): SavedFormat | undefined {
  if (!value || typeof value !== 'object') return undefined
  const f = value as Record<string, unknown>
  if (f.kind === 'best' || f.kind === 'worst' || f.kind === 'bestaudio') return { kind: f.kind }
  if (f.kind === 'height' && Number.isSafeInteger(f.height) && Number(f.height) > 0) {
    return { kind: 'height', height: Number(f.height) }
  }
  return undefined
}

export async function readPreferences(path: string): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return {
      format: savedFormat(value?.format),
      dir: typeof value?.dir === 'string' && value.dir.trim() && !/[\x00-\x1f]/.test(value.dir) ? value.dir : undefined
    }
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function writePreferences(path: string, value: Preferences): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

export function formatLabel(format: FormatSpec): string {
  switch (format.kind) {
    case 'height': return `${format.height}p`
    case 'bestaudio': return 'Audio only'
    case 'worst': return 'Smallest'
    case 'index': return `Format #${format.index}`
    default: return 'Best available'
  }
}
