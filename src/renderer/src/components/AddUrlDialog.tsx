import { useState } from 'react'
import { looksLikeUrl } from '../lib/format'
import { reportError } from '../store/toasts'
import { useT } from '../i18n'
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
  const t = useT()
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
      title={t('addDownloadTitle')}
      subtitle={t('addDownloadSubtitle')}
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
                .catch((err) => reportError(t('openTorrentFailed'), err))
                .finally(() => setChoosing(false))
            }}
            disabled={choosing}
          >
            <span className="inline-flex items-center gap-1.5">
              <TorrentIcon />
              {choosing ? t('opening') : t('torrentFile')}
            </span>
          </GhostButton>
          <span className="flex-1" />
          <GhostButton onClick={onClose}>{t('cancel')}</GhostButton>
          <PrimaryButton onClick={submit} disabled={valid.length === 0}>
            {valid.length > 1 ? t('addCountDownloads', { count: valid.length }) : t('continue')}
          </PrimaryButton>
        </>
      }
    >
      <label className="label">{t('address')}</label>
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
        placeholder={t('addressPlaceholder')}
        className="field font-mono text-[12px] leading-relaxed resize-none"
      />

      <div className="mt-2 h-4 text-[11.5px]">
        {invalid > 0 ? (
          <span className="text-warn">
            {t('linesSkipped', { count: invalid })}
          </span>
        ) : valid.length > 1 ? (
          <span className="text-faint">
            {t('willBeAddedByCategory', { count: valid.length })}
          </span>
        ) : (
          <span className="text-faint">{t('ctrlEnterHint')}</span>
        )}
      </div>
    </Dialog>
  )
}
