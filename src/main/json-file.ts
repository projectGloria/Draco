import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The tail of each file's write queue. Different files remain independent. */
const tails = new Map<string, Promise<void>>()
const lastBackupAt = new Map<string, number>()
const knownBackup = new Set<string>()
const BACKUP_INTERVAL_MS = 60_000

/** Capture a snapshot now, then commit writes to this path in call order. */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  pretty = true,
  backupMode: 'previous' | 'replace' = 'previous'
): Promise<void> {
  let payload: string
  try {
    payload = JSON.stringify(value, null, pretty ? 2 : undefined)
    if (payload === undefined) throw new TypeError('Cannot persist undefined JSON')
  } catch (error) {
    return Promise.reject(error)
  }

  const previous = tails.get(path) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => writePayload(path, payload, backupMode))
  tails.set(path, current)
  void current.finally(() => {
    if (tails.get(path) === current) tails.delete(path)
  }).catch(() => {})
  return current
}

async function writePayload(path: string, payload: string, backupMode: 'previous' | 'replace'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeSynced(tmp, payload)
    if (backupMode === 'previous') await preserveBackup(path)
    await rename(tmp, path)
    if (backupMode === 'replace') await writeBackup(path, payload, true)
    else await ensureFirstBackup(path, payload)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

async function writeSynced(path: string, payload: string): Promise<void> {
  const file = await open(path, 'wx')
  try {
    await file.writeFile(payload, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

/** Keep a prior parseable snapshot without copying every 4-second task update. */
async function preserveBackup(path: string): Promise<void> {
  if (Date.now() - (lastBackupAt.get(path) ?? 0) < BACKUP_INTERVAL_MS) return
  let previous: string | null = null
  try {
    const candidate = await readFile(path, 'utf8')
    JSON.parse(candidate)
    previous = candidate
  } catch {
    // A corrupt current file must never replace a useful backup.
  }
  if (previous === null) return
  await writeBackup(path, previous)
}

async function ensureFirstBackup(path: string, payload: string): Promise<void> {
  if (knownBackup.has(path)) return
  try {
    JSON.parse(await readFile(path + '.bak', 'utf8'))
    knownBackup.add(path)
    return
  } catch {
    await writeBackup(path, payload)
  }
}

async function writeBackup(path: string, payload: string, required = false): Promise<void> {
  const tmp = `${path}.${randomUUID()}.bak.tmp`
  try {
    await writeSynced(tmp, payload)
    await rename(tmp, path + '.bak')
    lastBackupAt.set(path, Date.now())
    knownBackup.add(path)
  } catch (error) {
    // Ordinary backup trouble need not block a synced primary. During legacy
    // secret migration the old backup must be replaced, so failure is reported.
    await rm(tmp, { force: true }).catch(() => {})
    if (required) throw error
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    try {
      return JSON.parse(await readFile(path + '.bak', 'utf8')) as T
    } catch {
      return null
    }
  }
}

/** A broken user-state file must stop startup rather than look like fresh data. */
export async function hasSavedState(path: string): Promise<boolean> {
  for (const candidate of [path, path + '.bak']) {
    try { await stat(candidate); return true } catch (error) {
      // Access and I/O failures are not evidence of a first run. Initializing
      // empty state here could overwrite the user's data once access returns.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return true
    }
  }
  return false
}

export async function readJsonOrThrowIfPresent<T>(path: string): Promise<T | null> {
  const value = await readJson<T>(path)
  if (value !== null) return value
  if (await hasSavedState(path)) {
    throw new Error(`Could not read saved state at ${path}; the primary file and backup are invalid or inaccessible`)
  }
  return null
}
