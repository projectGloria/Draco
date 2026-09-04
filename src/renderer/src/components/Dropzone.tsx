import React, { useState } from 'react'
import { PlusIcon } from './Icons'

export default function Dropzone(): React.ReactElement {
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className="w-full h-full border-2 rounded-xl flex items-center justify-center bg-black/60 backdrop-blur transition-colors"
      style={{
        borderColor: dragging ? 'var(--accent)' : 'var(--line)',
        color: dragging ? 'var(--accent)' : 'var(--faint)',
        userSelect: 'none',
        WebkitAppRegion: 'drag' // allow dragging the window by clicking on the widget
      } as React.CSSProperties}
      onDragEnter={(event) => {
        if ([...event.dataTransfer.types].some((type) => type === 'text/uri-list' || type === 'text/plain')) {
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
        const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
        const urls = [...new Set(raw.split(/[\r\n\s]+/).filter((value) => /^https?:\/\//i.test(value) || /^magnet:\?/i.test(value) || /^[0-9a-fA-F]{40}$/.test(value)))]
        
        if (urls.length === 1) {
          void window.api.addDownload({ url: urls[0] })
        } else if (urls.length > 1) {
          void window.api.addDownloads(urls.map((url) => ({ url })))
        }
      }}
    >
      <PlusIcon className="w-8 h-8 pointer-events-none" />
    </div>
  )
}
