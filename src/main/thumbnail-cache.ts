/** Bounds retained data URLs by size as well as count, with least-recently-used eviction. */
export class ThumbnailCache {
  private entries = new Map<string, { value: string | null; bytes: number }>()
  private bytes = 0
  private readonly maxEntries: number
  private readonly maxBytes: number

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  get(key: string): string | null | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: string | null): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.bytes -= previous.bytes
    }
    // Use the UTF-16 upper bound even when V8 can store ASCII more compactly.
    const bytes = 2 * (key.length + (value?.length ?? 0)) + 64
    if (bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldest)!.bytes
      this.entries.delete(oldest)
    }
  }
}
