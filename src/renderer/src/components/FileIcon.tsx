import { useFileIcon, useSiteIcon } from '../lib/icons'
import { DownloadIcon } from './Icons'

/**
 * The icon a file is shown with.
 *
 * Whatever opens this kind of file on this machine is the icon the user already
 * recognises - WinRAR's for a .rar, VLC's for a .mkv - so a download manager
 * that draws its own generic glyph on every row is throwing away the one piece
 * of recognition the desktop hands it for free. The glyph is still there as the
 * fallback for a type the shell has no association for, and for the moment
 * before the lookup answers.
 */
export default function FileIcon({
  name,
  className = 'w-3.5 h-3.5',
  color
}: {
  name: string
  className?: string
  /** Tint for the fallback glyph only; a real shell icon is left alone. */
  color?: string
}): React.ReactElement {
  const icon = useFileIcon(name)

  if (!icon) {
    return (
      <span style={{ color }}>
        <DownloadIcon className={className} />
      </span>
    )
  }

  return <img src={icon} alt="" draggable={false} className={className + ' object-contain'} />
}

/**
 * The mark for a download's source - the site's own favicon where it has one.
 *
 * A window that appeared because someone pressed Download on YouTube should say
 * YouTube on it. Falling back to the video glyph keeps the layout identical when
 * a site serves no icon.
 */
export function SiteIcon({
  url,
  className = 'w-4 h-4'
}: {
  url: string | null | undefined
  className?: string
}): React.ReactElement {
  const icon = useSiteIcon(url)

  if (!icon) return <DownloadIcon className={className} />
  return <img src={icon} alt="" draggable={false} className={className + ' object-contain'} />
}
