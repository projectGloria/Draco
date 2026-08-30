export interface HostConnectionLimit {
  host: string
  connections: number
}

/** Returns the most-specific hostname rule, including parent-domain rules. */
export function connectionsForUrl(
  rawUrl: string,
  fallback: number,
  rules: HostConnectionLimit[]
): number {
  let hostname: string
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return fallback
  }

  let selected: HostConnectionLimit | null = null
  for (const rule of rules) {
    const host = rule.host.toLowerCase()
    if (hostname !== host && !hostname.endsWith(`.${host}`)) continue
    if (!selected || host.length > selected.host.length) selected = rule
  }

  return selected ? Math.min(fallback, Math.max(1, selected.connections)) : fallback
}
