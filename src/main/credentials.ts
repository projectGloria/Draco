import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Credentials } from './engine/auth.ts'
import type { SiteCredential } from '@shared/types'
import { getPaths } from './bootstrap/paths.ts'
import { logger } from './log.ts'
import { readJsonOrThrowIfPresent, writeJsonAtomic } from './json-file.ts'

const log = logger('credentials')

/**
 * Passwords for sites that ask for one.
 *
 * Kept apart from the task and settings stores. Each secret is sealed with
 * `safeStorage`, which on Windows is DPAPI keyed
 * to the logged-in account - so the file is useless if it is copied off the
 * machine, and Draco itself never holds a decrypted password longer than the
 * request it is answering.
 *
 * When the OS offers no encryption, nothing is saved at all. Writing the
 * password in the clear "just this once" is how a password manager becomes a
 * text file.
 */

interface StoredCredential {
  id: string
  host: string
  realm: string
  username: string
  /** Base64 of the `safeStorage` ciphertext. Never a readable password. */
  secret: string
  createdAt: number
}

interface CredentialFile {
  version: number
  entries: StoredCredential[]
}

const FILE_VERSION = 1

let entries: StoredCredential[] = []
let loaded = false
let mutations: Promise<unknown> = Promise.resolve()

function changeCredentials<T>(change: () => Promise<T>): Promise<T> {
  const result = mutations.then(change)
  mutations = result.catch(() => {})
  return result
}

function filePath(): string {
  return getPaths().credentialsFile
}

/** Everything is matched on the hostname alone, lowercased, port included. */
export function hostOf(value: string): string | null {
  try {
    // Accept a bare hostname as well as a URL - the Options list is a place
    // where typing "files.example.com" is the obvious thing to do.
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? new URL(value) : new URL(`https://${value}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.host.toLowerCase() || null
  } catch {
    return null
  }
}

export async function loadCredentials(): Promise<void> {
  loaded = false
  const parsed = await readJsonOrThrowIfPresent<CredentialFile>(filePath())
  if (parsed === null) {
    entries = []
    loaded = true
    return
  }
  if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries) || !parsed.entries.every(
      (entry) =>
        typeof entry?.id === 'string' &&
        typeof entry.host === 'string' &&
        typeof entry.username === 'string' &&
        typeof entry.secret === 'string'
  )) {
    throw new Error('Could not read saved state: saved site credentials have an invalid format')
  }
  entries = parsed.entries.map((entry) => ({ ...entry, realm: typeof entry.realm === 'string' ? entry.realm : '' }))
  loaded = true
  log.info(`${entries.length} saved site credential(s)`)
}

async function persist(nextEntries: StoredCredential[]): Promise<void> {
  const body: CredentialFile = { version: FILE_VERSION, entries: nextEntries }
  await writeJsonAtomic(filePath(), body)
}

/** What the renderer is allowed to see: everything except the password. */
export function listCredentials(): SiteCredential[] {
  return entries.map((entry) => ({
    id: entry.id,
    host: entry.host,
    realm: entry.realm ?? '',
    username: entry.username,
    createdAt: entry.createdAt
  }))
}

export async function saveCredential(input: {
  host: string
  realm?: string
  username: string
  password: string
}): Promise<SiteCredential> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows will not encrypt saved passwords right now, so none were saved')
  }

  const host = hostOf(String(input.host ?? ''))
  if (!host) throw new Error('That is not a host Draco can match against')
  const username = String(input.username ?? '').slice(0, 200)
  const password = String(input.password ?? '')
  if (!username || !password) throw new Error('A username and a password are both needed')

  const realm = String(input.realm ?? '').slice(0, 200)
  const secret = safeStorage.encryptString(password).toString('base64')

  // One entry per host and realm: saving again is correcting a password, not
  // collecting another one that will silently never be tried.
  return changeCredentials(async () => {
    if (!loaded) await loadCredentials()
    const existing = entries.find((entry) => entry.host === host && entry.realm === realm)
    const entry: StoredCredential = existing
      ? { ...existing, username, secret }
      : { id: randomUUID(), host, realm, username, secret, createdAt: Date.now() }
    const nextEntries = existing
      ? entries.map((row) => (row.id === existing.id ? entry : row))
      : [...entries, entry]
    await persist(nextEntries)
    entries = nextEntries
    log.info(`saved credentials for ${host}${realm ? ` (${realm})` : ''}`)
    return { id: entry.id, host, realm, username, createdAt: entry.createdAt }
  })
}

export async function removeCredential(id: string): Promise<boolean> {
  return changeCredentials(async () => {
    if (!loaded) await loadCredentials()
    const nextEntries = entries.filter((entry) => entry.id !== id)
    if (nextEntries.length === entries.length) return false
    await persist(nextEntries)
    entries = nextEntries
    return true
  })
}

/**
 * The password for this request, decrypted only now.
 *
 * A realm-specific entry wins over a host-wide one, because a server with two
 * protected areas is exactly the case where one password is not the other. A
 * host-wide entry (saved with no realm) answers anything on that host, which is
 * what someone saving a password for "files.example.com" expects.
 */
export function resolveCredentials(url: string, realm: string): Credentials | null {
  if (!loaded) return null
  const host = hostOf(url)
  if (!host) return null

  const candidates = entries.filter((entry) => entry.host === host)
  const match =
    candidates.find((entry) => entry.realm && entry.realm === realm) ??
    candidates.find((entry) => !entry.realm)
  if (!match) return null

  try {
    const password = safeStorage.decryptString(Buffer.from(match.secret, 'base64'))
    return { username: match.username, password }
  } catch (error) {
    // A secret sealed under a different Windows account, or a corrupted file.
    // Treated as "no password", never as an empty one - sending a blank
    // password would burn the server's retry allowance for nothing.
    log.warn(`could not decrypt the saved password for ${host}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Whether anything at all is saved for this host, for the message on a 401. */
export function hasCredentialsFor(url: string): boolean {
  const host = hostOf(url)
  return host !== null && entries.some((entry) => entry.host === host)
}
