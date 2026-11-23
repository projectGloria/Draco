const PLAYABLE_VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mkv',
  'mov',
  'm4v',
  'avi',
  'mpg',
  'mpeg',
  'ts',
  'ogv',
  '3gp'
])

const PLAYABLE_AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'wav'
])

export function mediaExtensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

export function isPlayableVideoExtension(filename: string): boolean {
  return PLAYABLE_VIDEO_EXTENSIONS.has(mediaExtensionOf(filename))
}

export function isPlayableMediaExtension(filename: string): boolean {
  const ext = mediaExtensionOf(filename)
  return PLAYABLE_VIDEO_EXTENSIONS.has(ext) || PLAYABLE_AUDIO_EXTENSIONS.has(ext)
}

export function isPlayableMediaTask(task: {
  filename: string
  mimeType?: string | null
  kind?: string
  torrentInfo?: { files: Array<{ path: string; selected: boolean }> }
  torrentFiles?: Array<{ path: string }>
  selectedFiles?: string[]
}): boolean {
  if (task.kind === 'hls' || task.kind === 'dash') return true
  if (task.kind === 'torrent') {
    const selected = task.selectedFiles ? new Set(task.selectedFiles) : null
    const files = task.torrentInfo?.files ?? task.torrentFiles ?? []
    return files.some((file) => (!selected || selected.has(file.path)) && isPlayableMediaExtension(file.path))
  }
  if (isPlayableMediaExtension(task.filename)) return true
  if (task.mimeType) {
    const lower = task.mimeType.toLowerCase()
    if (lower.startsWith('video/') || lower.startsWith('audio/')) return true
  }
  return false
}

export function mimeTypeForMediaFilename(filename: string, fallback?: string | null): string {
  const ext = mediaExtensionOf(filename)
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'mov':
      return 'video/quicktime'
    case 'avi':
      return 'video/x-msvideo'
    case 'ts':
      return 'video/mp2t'
    case 'mpg':
    case 'mpeg':
      return 'video/mpeg'
    case 'ogv':
      return 'video/ogg'
    case '3gp':
      return 'video/3gpp'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'aac':
      return 'audio/aac'
    case 'flac':
      return 'audio/flac'
    case 'ogg':
    case 'opus':
      return 'audio/ogg'
    case 'wav':
      return 'audio/wav'
    default:
      return fallback && /^(?:video|audio)\//i.test(fallback) ? fallback.split(';')[0].trim() : 'video/mp4'
  }
}
