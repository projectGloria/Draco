import { useState } from 'react'
import { looksLikeUrl } from '../lib/format'
import { reportError } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { TorrentIcon } from './Icons'

/**
 * IDM's "Add URL" box. One URL per line, so pasting a list from somewhere else
 * does the obvious thing instead of failing validation on the whole blob.
 */

export default function AddUrlDialog({
  onSubmit,
  onClose
}: {
  onSubmit(urls: string[]): void
  onClose(): void
}): React.ReactElement {
  const [text, setText] = useState('')
  const [choosing, setChoosing] = useState(false)

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const valid = lines.filter(looksLikeUrl)
  const invalid = lines.length - valid.length

  const submit = (): void => {
    if (valid.length === 0) return
    onSubmit(valid)
    onClose()
  }

  return (
    <Dialog
      title="Add download"
      subtitle="Paste a URL, magnet link, or torrent info hash"
      width={560}
      onClose={onClose}
      footer={
        <>
          {/* Double-clicking a torrent is the usual way in; this is the way in
              when Windows has some other client registered for the type. */}
          <GhostButton
            onClick={() => {
              setChoosing(true)
              void window.api
                .chooseTorrentFile()
                .then((magnetUri) => {
                  if (!magnetUri) return
                  onSubmit([magnetUri])
                  onClose()
                })
                .catch((err) => reportError('Could not open that torrent file', err))
                .finally(() => setChoosing(false))
            }}
            disabled={choosing}
          >
            <span className="inline-flex items-center gap-1.5">
              <TorrentIcon />
              {choosing ? 'Opening…' : 'Torrent file…'}
            </span>
          </GhostButton>
          <span className="flex-1" />
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={valid.length === 0}>
            {valid.length > 1 ? `Add ${valid.length} downloads` : 'Continue'}
          </PrimaryButton>
        </>
      }
    >
      <label className="label">Address</label>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl+Enter submits; a plain Enter has to stay available for the
          // next URL in the list.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit()
        }}
        rows={5}
        spellCheck={false}
        placeholder="https://example.com/file.iso, magnet link, or 40-character torrent hash"
        className="field font-mono text-[12px] leading-relaxed resize-none"
      />

      <div className="mt-2 h-4 text-[11.5px]">
        {invalid > 0 ? (
          <span className="text-warn">
            {invalid} line{invalid === 1 ? '' : 's'} skipped — enter a URL, magnet link, or torrent
            info hash
          </span>
        ) : valid.length > 1 ? (
          <span className="text-faint">
            {valid.length} downloads will be added and filed by category
          </span>
        ) : (
          <span className="text-faint">Ctrl+Enter to continue</span>
        )}
      </div>
    </Dialog>
  )
}
