import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULT_TORRENT_TRACKERS } from './create.ts'
import type { TorrentProbeMetadata } from './probe.ts'

/**
 * Draco's copy of every `.torrent` file it has been handed.
 *
 * A task is identified by its URL, and a local file path is not one: the file
 * a user double-clicked lives in Downloads, gets tidied away a week later, and
 * a paused 40 GB torrent must still be resumable after that. So the descriptor
 * is copied in here on import, keyed by info hash, and the task itself carries
 * the magnet URI derived from it - which is exactly what a task added from a
 * magnet link carries, so everything downstream stays on one path.
 *
 * Having the descriptor also means the file list is known immediately. A magnet
 * has to find a peer before it can say what is inside it; an imported torrent
 * already knows, so the Add-torrent dialog fills in with no network at all.
 *
 * Deliberately free of Electron imports, like the rest of `engine/` - the
 * directory is injected, the way `log.ts` is given its own.
 */

let storeDir: string | null = null

/** Bencoded descriptors are small; anything this big is not one. */
const MAX_DESCRIPTOR_BYTES = 10 * 1024 * 1024

export function setTorrentStoreDir(dir: string): void {
  storeDir = dir
}

export interface ImportedTorrent {
  /** The magnet the task is created from. */
  magnetUri: string
  infoHash: string
  name: string
  files: Array<{ path: string; size: number }>
  totalSize: number
}

/**
 * The info hash a magnet URI names, lowercase hex, or null if it names none.
 *
 * `parse-torrent` is the authority here rather than a regular expression of our
 * own: `xt` may carry the hash in base32, and the query is not always in the
 * order it was written in.
 */
export async function infoHashFromMagnet(url: string): Promise<string | null> {
  if (!url.startsWith('magnet:')) return null
  try {
    const { default: parseTorrent } = await import('parse-torrent')
    const parsed = await parseTorrent(url)
    const hash = String(parsed.infoHash ?? '').toLowerCase()
    return /^[a-f0-9]{40}$/.test(hash) ? hash : null
  } catch {
    return null
  }
}

function descriptorPath(infoHash: string): string | null {
  if (!storeDir || !/^[a-f0-9]{40}$/.test(infoHash)) return null
  return join(storeDir, `${infoHash}.torrent`)
}

/**
 * Reads a `.torrent` from disk, copies it into the store, and returns the
 * magnet URI that stands for it from here on.
 *
 * The trackers the file lists are carried into the magnet, so a private or
 * poorly-seeded torrent keeps the announce URLs that are the only way to find
 * its swarm. Draco's public fallbacks are added only when the file names none.
 */
export async function importTorrentFile(filePath: string): Promise<ImportedTorrent> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(filePath))
  } catch (error) {
    throw new Error(`Could not read that torrent file: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (bytes.length === 0) throw new Error('That torrent file is empty')
  if (bytes.length > MAX_DESCRIPTOR_BYTES) throw new Error('That file is too large to be a torrent descriptor')

  const { default: parseTorrent, toMagnetURI } = await import('parse-torrent')
  let parsed: Awaited<ReturnType<typeof parseTorrent>>
  try {
    parsed = await parseTorrent(bytes)
  } catch {
    throw new Error('That file is not a valid torrent')
  }

  const infoHash = String(parsed.infoHash ?? '').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(infoHash)) throw new Error('That torrent file has no usable info hash')

  const files = (parsed.files ?? []).map((file) => ({
    path: String(file.path),
    size: Number(file.length) || 0
  }))
  if (files.length === 0) throw new Error('That torrent file lists no files')

  const announce = Array.isArray(parsed.announce) ? parsed.announce.filter((url) => typeof url === 'string') : []
  const magnetUri = toMagnetURI({
    infoHash,
    name: parsed.name,
    announce: announce.length > 0 ? announce : [...DEFAULT_TORRENT_TRACKERS]
  })

  await storeDescriptor(infoHash, bytes)

  return {
    magnetUri,
    infoHash,
    name: String(parsed.name || 'torrent_download'),
    files,
    totalSize: Number(parsed.length ?? files.reduce((sum, file) => sum + file.size, 0))
  }
}

/** Same temp-file-and-rename discipline as the journal, for the same reason. */
async function storeDescriptor(infoHash: string, bytes: Uint8Array): Promise<void> {
  const target = descriptorPath(infoHash)
  if (!target) return
  const tmp = `${target}.${randomUUID()}.tmp`
  try {
    await mkdir(storeDir!, { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, target)
  } catch {
    // A descriptor that could not be kept costs the offline file list and the
    // instant metadata, not the download: the magnet still resolves over DHT.
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * The stored descriptor for a magnet, if this torrent was imported from a file.
 *
 * Returned in the shape the runner and the probe already consume from the
 * network cache, so both can simply try this first.
 */
export async function localTorrentDescriptor(
  magnetUrl: string
): Promise<{ metadata: TorrentProbeMetadata; torrentId: Uint8Array } | undefined> {
  const infoHash = await infoHashFromMagnet(magnetUrl)
  if (!infoHash) return undefined
  const path = descriptorPath(infoHash)
  if (!path) return undefined

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch {
    return undefined
  }
  if (bytes.length === 0 || bytes.length > MAX_DESCRIPTOR_BYTES) return undefined

  try {
    const { default: parseTorrent } = await import('parse-torrent')
    const parsed = await parseTorrent(bytes)
    // The store is keyed by hash, so a mismatch means the file on disk is not
    // the one that was asked for - never hand a runner the wrong payload.
    if (String(parsed.infoHash).toLowerCase() !== infoHash || !parsed.files) return undefined
    return {
      torrentId: bytes,
      metadata: {
        name: parsed.name || 'torrent_download',
        length: Number(parsed.length ?? parsed.files.reduce((sum, file) => sum + file.length, 0)),
        files: parsed.files.map((file) => ({ path: file.path, length: file.length }))
      }
    }
  } catch {
    return undefined
  }
}
