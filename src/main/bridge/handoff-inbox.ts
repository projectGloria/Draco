import type { HandoffRequest } from '../../shared/types.ts'
import { validateUrl } from '../engine/create.ts'
import { writeJsonAtomic } from '../json-file.ts'
import { readSealedJsonFile, sealJson, type StringCipher } from '../sealed-json.ts'

/** Only browser file confirmations belong here; media pickers are transient. */
const MAX_PENDING = 12
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_AGE_MS = 5 * 60_000

function validEntry(value: unknown, now: number): value is HandoffRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<HandoffRequest>
  if (item.kind !== 'file' || typeof item.id !== 'string' || !ID.test(item.id)) return false
  if (typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt) ||
      item.expiresAt <= now || item.expiresAt > now + MAX_AGE_MS) return false
  if (typeof item.url !== 'string' || item.url.length > 32_768) return false
  try { validateUrl(item.url, { allowPrivate: false }) } catch { return false }
  if (item.filename !== undefined && (typeof item.filename !== 'string' || item.filename.length > 512)) return false
  if (item.size !== null && (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0)) return false
  if (item.mimeType !== null && (typeof item.mimeType !== 'string' || item.mimeType.length > 1024)) return false
  if (!item.headers || typeof item.headers !== 'object' || Array.isArray(item.headers)) return false
  for (const [key, limit] of Object.entries({ cookie: 1_000_000, referer: 32_768, userAgent: 1024, authorization: 4096 })) {
    const header = item.headers[key as keyof typeof item.headers]
    if (header !== undefined && (typeof header !== 'string' || header.length > limit)) return false
  }
  if (item.pageUrl !== undefined && typeof item.pageUrl !== 'string') return false
  return true
}

/** Serializes inbox changes so the durable snapshot and memory agree. */
export class BrowserHandoffInbox {
  private entries = new Map<string, HandoffRequest>()
  private tail: Promise<void> = Promise.resolve()
  private readonly path: string
  private readonly cipher: StringCipher

  constructor(path: string, cipher: StringCipher) {
    this.path = path
    this.cipher = cipher
  }

  async load(now = Date.now()): Promise<HandoffRequest[]> {
    const stored = await readSealedJsonFile(this.path, this.cipher)
    const opened = stored ?? { value: [], legacy: false, fromBackup: false, repairBackup: false }
    if (!Array.isArray(opened.value)) throw new Error('Saved browser handoffs must be a list')
    const next = new Map<string, HandoffRequest>()
    for (const raw of opened.value) {
      if (validEntry(raw, now) && !next.has(raw.id) && next.size < MAX_PENDING) {
        next.set(raw.id, raw)
      }
    }
    if (opened.legacy || opened.repairBackup || opened.value.length !== next.size) {
      await writeJsonAtomic(this.path, sealJson([...next.values()], this.cipher), false,
        opened.legacy || opened.repairBackup ? 'replace' : 'previous')
    }
    this.entries = next
    return this.list()
  }

  list(): HandoffRequest[] { return [...this.entries.values()] }
  get(id: string): HandoffRequest | undefined { return this.entries.get(id) }

  offer(request: HandoffRequest): Promise<HandoffRequest> {
    return this.enqueue(async () => {
      const existing = this.entries.get(request.id)
      if (existing) return existing
      if (this.entries.size >= MAX_PENDING) throw new Error('Too many pending browser confirmations')
      if (!validEntry(request, Date.now())) throw new Error('Invalid or expired browser confirmation')
      const next = new Map(this.entries)
      next.set(request.id, request)
      await writeJsonAtomic(this.path, sealJson([...next.values()], this.cipher), false)
      this.entries = next
      return request
    })
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.entries.has(id)) return
      const next = new Map(this.entries)
      next.delete(id)
      await writeJsonAtomic(this.path, sealJson([...next.values()], this.cipher), false)
      this.entries = next
    })
  }

  prune(now = Date.now(), keep: (id: string) => boolean = () => false): Promise<string[]> {
    return this.enqueue(async () => {
      const next = new Map(this.entries)
      const removed: string[] = []
      for (const [id, item] of next) {
        if (!keep(id) && (item.expiresAt ?? 0) <= now) {
          next.delete(id)
          removed.push(id)
        }
      }
      if (removed.length > 0) {
        await writeJsonAtomic(this.path, sealJson([...next.values()], this.cipher), false)
        this.entries = next
      }
      return removed
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(operation)
    this.tail = work.then(() => {}, () => {})
    return work
  }
}
