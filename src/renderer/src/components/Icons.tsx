import appIcon from '../../../../resources/icon.png'

/**
 * Every glyph in the app, as inline SVG.
 *
 * An icon font or a sprite sheet would be another asset the CSP has to allow
 * and another thing that can fail to load; these are 24×24 strokes that inherit
 * `currentColor` and scale with the class they are given.
 */

interface GlyphProps {
  className?: string
}

function Svg({
  children,
  className,
  fill
}: GlyphProps & { children: React.ReactNode; fill?: boolean }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? 'w-4 h-4'}
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function BrandMark({ className }: GlyphProps): React.ReactElement {
  return <img src={appIcon} alt="" draggable={false} className={(className ?? 'w-5 h-5') + ' object-contain'} />
}

/* Window controls. Drawn on the pixel grid at 10px, hence the flat paths. */

export function MinimizeGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" aria-hidden="true">
      <path d="M0 5 H10" stroke="currentColor" strokeWidth={1} />
    </svg>
  )
}

export function MaximizeGlyph({ maximized }: { maximized: boolean }): React.ReactElement {
  return (
    <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" fill="none" aria-hidden="true">
      {maximized ? (
        <>
          <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth={1} />
          <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" stroke="currentColor" strokeWidth={1} />
        </>
      ) : (
        <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth={1} />
      )}
    </svg>
  )
}

export function CloseGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 10 10" className="w-2.5 h-2.5" aria-hidden="true">
      <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth={1} />
    </svg>
  )
}

/* Toolbar and rows */

export function PlusIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function PlayIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props} fill>
      <path d="M8 5.5 L18.5 12 L8 18.5 Z" />
    </Svg>
  )
}

export function PauseIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props} fill>
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" />
    </Svg>
  )
}

export function StopAllIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props} fill>
      <rect x="4" y="5.5" width="3.2" height="13" rx="1" />
      <rect x="10.4" y="5.5" width="3.2" height="13" rx="1" />
      <rect x="16.8" y="5.5" width="3.2" height="13" rx="1" />
    </Svg>
  )
}

export function TrashIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 7h16M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7" />
      <path d="M6.5 7l.8 12.1A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  )
}

export function BroomIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 7h11M4 12h8M4 17h5" />
      <path d="M14.5 16.5 L17 19 L21 13.5" />
    </Svg>
  )
}

export function GearIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.6v2.3M12 19.1v2.3M4.4 7.3l2 1.15M17.6 15.55l2 1.15M4.4 16.7l2-1.15M17.6 8.45l2-1.15" />
    </Svg>
  )
}

export function CalendarIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </Svg>
  )
}

export function VideoIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <rect x="2.6" y="6" width="13" height="12" rx="2.4" />
      <path d="M15.6 10.4 L21.4 7.4 v9.2 l-5.8-3z" />
    </Svg>
  )
}

export function FolderIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M3 7.2a2 2 0 0 1 2-2h3.6l1.8 2.2H19a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  )
}

export function DownloadIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 3.5v11M12 15.5 7.2 10.4M12 15.5l4.8-5.1M4.5 19.5h15" />
    </Svg>
  )
}

export function InfoIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.4M12 7.9v.1" />
    </Svg>
  )
}

export function CheckIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M4.8 12.6 9.6 17.4 19.2 6.6" />
    </Svg>
  )
}

export function AlertIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 4.4 21.2 19.6H2.8z" />
      <path d="M12 10v4M12 17.1v.1" />
    </Svg>
  )
}

export function ChevronIcon({
  open,
  className
}: GlyphProps & { open: boolean }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      className={(className ?? 'w-3 h-3') + ' transition-transform duration-150'}
      style={{ transform: open ? 'rotate(90deg)' : 'none' }}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

export function SortArrow({ direction }: { direction: 'asc' | 'desc' }): React.ReactElement {
  return (
    <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 shrink-0" aria-hidden="true">
      <path
        d={direction === 'asc' ? 'M6 3 L10 8 H2 Z' : 'M6 9 L2 4 H10 Z'}
        fill="currentColor"
      />
    </svg>
  )
}

export function SearchIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <circle cx="10.8" cy="10.8" r="6.2" />
      <path d="M15.4 15.4 20 20" />
    </Svg>
  )
}

export function RefreshIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.4 4.4v4.2h-4.2" />
    </Svg>
  )
}

export function LinkIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2" />
    </Svg>
  )
}

export function CopyIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2.2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </Svg>
  )
}

export function ListIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </Svg>
  )
}

export function LayersIcon(props: GlyphProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 3.4 21 8l-9 4.6L3 8z" />
      <path d="M3 12.6 12 17.2l9-4.6M3 16.6 12 21.2l9-4.6" />
    </Svg>
  )
}
