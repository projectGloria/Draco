import React, { useEffect, useState } from 'react'
import { PlusIcon } from './Icons'
import { useApp } from '../store/app'
import { useAppearance } from '../lib/use-appearance'

export default function Dropzone(): React.ReactElement {
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const failed = (reason: unknown): void => setError(reason instanceof Error ? reason.message : String(reason))
  const settings = useApp((state) => state.settings)
  useAppearance(settings)
  useEffect(() => {
    let active = true
    void window.api.getSettings().then((settings) => {
      if (active) useApp.setState({ settings })
    }).catch(failed)
    return () => { active = false }
  }, [])

  return (
    <div
      className="w-full h-full border-2 rounded-xl flex items-center justify-center bg-black/60 backdrop-blur transition-colors"
      style={{
        borderColor: dragging ? 'var(--accent)' : 'var(--color-line)',
        color: dragging ? 'var(--accent)' : 'var(--color-faint)',
        userSelect: 'none',
        WebkitAppRegion: 'drag' // allow dragging the window by clicking on the widget
      } as React.CSSProperties}
      onDragEnter={(event) => {
        if ([...event.dataTransfer.types].some((type) => type === 'Files' || type === 'text/uri-list' || type === 'text/plain')) {
          event.preventDefault()
          setDragging(true)
        }
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        setError(null)
        // Dropped `.torrent` files take the same road as a double-clicked one:
        // main opens them, the main window shows the dialog.
        const paths = [...event.dataTransfer.files]
          .map((file) => window.api.pathForDroppedFile(file))
          .filter((path) => path.length > 0)
        if (paths.length > 0) {
          void window.api.openTorrentFiles(paths).catch(failed)
          return
        }

        const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
        const urls = [...new Set(raw.split(/[\r\n\s]+/).filter((value) => /^https?:\/\//i.test(value) || /^magnet:\?/i.test(value) || /^[0-9a-fA-F]{40}$/.test(value)))]
        
        if (urls.length === 1) {
          void window.api.addDownload({ url: urls[0] }).catch(failed)
        } else if (urls.length > 1) {
          void window.api.addDownloads(urls.map((url) => ({ url }))).catch(failed)
        }
      }}
    >
      {error ? <span role="alert" title={error} className="px-2 text-center text-[10px] text-err line-clamp-3 pointer-events-none">{error}</span>
        : <PlusIcon className="w-8 h-8 pointer-events-none" />}
    </div>
  )
}
