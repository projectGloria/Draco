import { safeStorage } from 'electron'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StringCipher } from './sealed-json.ts'

/**
 * Electron may accept encryptString before its new Windows profile key has
 * reached Local State. A crash in that interval makes every sealed snapshot
 * unreadable on restart, so bootstrap waits for the key before loading tasks.
 */
export async function ensureElectronJsonCipherReady(userData: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable')
  const probe = safeStorage.encryptString('draco-key-check')
  if (safeStorage.decryptString(probe) !== 'draco-key-check') {
    throw new Error('OS encryption did not round-trip')
  }
  if (process.platform !== 'win32') return

  const statePath = join(userData, 'Local State')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        os_crypt?: { encrypted_key?: unknown }
      }
      if (typeof state.os_crypt?.encrypted_key === 'string' && state.os_crypt.encrypted_key) {
        const file = await open(statePath, 'r+')
        try { await file.sync() } finally { await file.close() }
        return
      }
    } catch {
      // Chromium writes this preference asynchronously on a fresh profile.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Windows encryption key was not saved; download state cannot safely start')
}

/** Requires OS encryption; no plaintext fallback for URLs or headers. */
export const electronJsonCipher: StringCipher = {
  seal(plaintext) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows encryption is unavailable; download state was not saved')
    }
    return safeStorage.encryptString(plaintext).toString('base64')
  },
  open(ciphertext) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows encryption is unavailable; saved download state cannot be opened')
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) {
      throw new Error('Invalid encrypted state payload')
    }
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
  }
}
