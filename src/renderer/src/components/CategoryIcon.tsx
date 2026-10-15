import type { Category } from '@shared/types'
import { FolderIcon } from './Icons'
import QueueIcon from './QueueIcon'

export default function CategoryIcon({ category, className = 'w-[15px] h-[15px]' }: {
  category: Category; className?: string
}): React.ReactElement {
  const extensions = category.extensions.map((ext) => ext.toLowerCase())
  const has = (values: string[]): boolean => values.some((ext) => extensions.includes(ext))
  if (has(['zip', 'rar', '7z', 'tar'])) return <QueueIcon icon="archive" className={className} />
  if (has(['mp3', 'flac', 'wav', 'opus'])) return <QueueIcon icon="music" className={className} />
  if (has(['mp4', 'mkv', 'avi', 'webm'])) return <QueueIcon icon="video" className={className} />
  const document = has(['pdf', 'doc', 'docx', 'txt', 'epub'])
  const program = has(['exe', 'msi', 'apk', 'dmg', 'deb'])
  if (!document && !program) return <FolderIcon className={className} />
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {document ? <><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6" /></>
      : <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01m-2 6 3 2-3 2m6 0h3" /></>}
  </svg>
}
