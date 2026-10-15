/** A JSON envelope that keeps tokens and request headers out of readable state files. */
import { readFile } from 'node:fs/promises'
import { hasSavedState } from './json-file.ts'

export interface StringCipher {
  seal(plaintext: string): string
  open(ciphertext: string): string
}

interface Envelope {
  sealedVersion: 1
  payload: string
}

export function sealJson(value: unknown, cipher: StringCipher): Envelope {
  const plaintext = JSON.stringify(value)
  if (plaintext === undefined) throw new TypeError('Cannot seal undefined JSON')
  return { sealedVersion: 1, payload: cipher.seal(plaintext) }
}

export function openJson(value: unknown, cipher: StringCipher): { value: unknown; legacy: boolean } {
  if (Array.isArray(value)) return { value, legacy: true }
  if (!value || typeof value !== 'object') throw new Error('Invalid sealed JSON state')
  const envelope = value as Partial<Envelope>
  if (envelope.sealedVersion !== 1 || typeof envelope.payload !== 'string') {
    throw new Error('Unsupported sealed JSON state')
  }
  try {
    return { value: JSON.parse(cipher.open(envelope.payload)), legacy: false }
  } catch (error) {
    throw new Error('Could not decrypt saved state for this Windows account', { cause: error })
  }
}

/** A parseable envelope can still have a damaged or foreign ciphertext. */
export async function readSealedJsonFile(
  path: string,
  cipher: StringCipher
): Promise<{ value: unknown; legacy: boolean; fromBackup: boolean; repairBackup: boolean } | null> {
  for (const [candidate, fromBackup] of [[path, false], [path + '.bak', true]] as const) {
    try {
      const opened = openJson(JSON.parse(await readFile(candidate, 'utf8')), cipher)
      if (fromBackup) return { ...opened, fromBackup: true, repairBackup: true }
      let repairBackup = false
      try {
        const backup = openJson(JSON.parse(await readFile(path + '.bak', 'utf8')), cipher)
        repairBackup = backup.legacy
      } catch {
        repairBackup = true
      }
      return { ...opened, fromBackup: false, repairBackup }
    } catch {
      // Try the other synced snapshot before reporting lost access.
    }
  }
  if (await hasSavedState(path)) {
    throw new Error(`Could not decrypt saved state at ${path}; the primary and backup are invalid or inaccessible`)
  }
  return null
}
