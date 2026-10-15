/** Safe label for task surfaces; a full URL may contain passwords or signed tokens. */
export function displaySource(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    if (url.protocol === 'magnet:') return 'Magnet link'
  } catch {
    // Damaged legacy records should not be rendered verbatim either.
  }
  return 'Download source'
}
