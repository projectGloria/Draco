/** Read a response with a hard cap before buffering its complete body. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Response exceeds ${maxBytes} bytes`)
  }
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) { complete = true; break }
      total += value.length
      if (total > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`)
      chunks.push(value)
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  return (await readResponseBytes(response, maxBytes)).toString('utf8')
}

/** Read only the beginning of a media body when a server ignores Range. */
export async function readResponsePrefix(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) { complete = true; break }
      const take = Math.min(value.length, maxBytes - total)
      chunks.push(value.subarray(0, take))
      total += take
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}
