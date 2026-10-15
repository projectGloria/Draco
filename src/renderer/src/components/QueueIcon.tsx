import type { QueueIconName } from '@shared/queue-order'
import { DownloadIcon, FolderIcon, LayersIcon, VideoIcon } from './Icons'

export default function QueueIcon({ icon, className = 'w-4 h-4' }: { icon?: QueueIconName; className?: string }): React.ReactElement {
  const Icon = icon === 'folder' ? FolderIcon : icon === 'download' ? DownloadIcon : icon === 'video' ? VideoIcon : LayersIcon
  if (icon === 'music' || icon === 'archive') return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icon === 'music' ? <><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>
        : <><path d="M4 8h16v13H4zM3 3h18v5H3zM9 12h6" /></>}
    </svg>
  )
  return <Icon className={className} />
}
